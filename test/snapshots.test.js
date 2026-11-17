import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChangeSnapshots } from '../src/snapshots.js'

async function tempStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rg-snapshots-'))
  return { dir, store: new ChangeSnapshots({ dir }) }
}

const payload = {
  mode: 'graph',
  turn: 3,
  total: 2,
  added: 4,
  deleted: 1,
  files: [
    { path: 'src/a.ts', display: 'src/a.ts', added: 4, deleted: 1, index: 0, content: 'SECRET CONTENT' },
    { path: 'src/b.ts', added: 0, deleted: 0, index: 1, oversized: true },
  ],
  units: [{ key: 'src', files: [{ path: 'src/a.ts' }] }],
  hints: [{ text: 'SECRET HINT' }],
}

test('snapshots: capture keeps metadata only and read round-trips', async () => {
  const { dir, store } = await tempStore()
  try {
    await store.capture('session-1', 5, payload)
    const snapshot = await store.read('session-1', 5)
    assert.equal(snapshot.turn, 3)
    assert.equal(snapshot.total, 2)
    assert.equal(snapshot.added, 4)
    assert.equal(snapshot.deleted, 1)
    assert.equal(snapshot.files.length, 2)
    assert.equal(snapshot.files[0].path, 'src/a.ts')
    assert.equal(snapshot.files[0].display, 'src/a.ts')
    assert.equal(snapshot.files[1].oversized, true)
    assert.ok(snapshot.capturedAt.length > 0)
    const raw = await fsp.readFile(store.filePath('session-1', 5), 'utf8')
    assert.ok(!raw.includes('SECRET'), 'snapshots must not store contents or hint text')
    assert.ok(!raw.includes('hints'))
    assert.ok(!raw.includes('units'))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('snapshots: missing, malformed, and mismatched records read as undefined', async () => {
  const { dir, store } = await tempStore()
  try {
    assert.equal(await store.read('session-1', 5), undefined)
    await fsp.writeFile(store.filePath('session-1', 5), '{not json', 'utf8')
    assert.equal(await store.read('session-1', 5), undefined)
    await fsp.writeFile(store.filePath('session-1', 6), JSON.stringify({
      v: 1,
      sessionId: 'other-session',
      seq: 6,
      turn: 1,
      files: [{ path: 'a.ts', added: 0, deleted: 0 }],
    }), 'utf8')
    assert.equal(await store.read('session-1', 6), undefined)
    await fsp.writeFile(store.filePath('session-1', 7), JSON.stringify({
      v: 1,
      sessionId: 'session-1',
      seq: 7,
      turn: 1,
      files: [{ path: '', added: 0, deleted: 0 }],
    }), 'utf8')
    assert.equal(await store.read('session-1', 7), undefined)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('snapshots: prune keeps the newest 20 entries', async () => {
  const { dir, store } = await tempStore()
  try {
    for (let seq = 1; seq <= 23; seq += 1) await store.capture('session-1', seq, payload)
    const names = (await fsp.readdir(dir)).filter(name => name.endsWith('.json'))
    assert.equal(names.length, 20)
    assert.ok(names.includes(path.basename(store.filePath('session-1', 23))), 'the newest snapshot must survive')
    assert.ok(!names.includes(path.basename(store.filePath('session-1', 1))), 'the oldest snapshots must be pruned')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('snapshots: a write failure only warns once', async () => {
  const warnings = []
  const blocker = await fsp.mkdtemp(path.join(os.tmpdir(), 'rg-snapshots-blocked-'))
  try {
    const filePath = path.join(blocker, 'not-a-directory')
    await fsp.writeFile(filePath, '', 'utf8')
    const store = new ChangeSnapshots({ dir: filePath, logger: { warn: (...args) => warnings.push(args) } })
    await store.capture('session-1', 1, payload)
    await store.capture('session-1', 2, payload)
    assert.equal(warnings.length, 1)
    assert.equal(await store.read('session-1', 1), undefined)
  } finally {
    await fsp.rm(blocker, { recursive: true, force: true })
  }
})
