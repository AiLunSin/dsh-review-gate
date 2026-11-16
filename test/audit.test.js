import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AuditLog, localDate } from '../src/audit.js'

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'review-gate-audit-'))
}

test('audit: localDate formats a local calendar day', () => {
  assert.equal(localDate(new Date(2026, 10, 17, 23, 5)), '2026-11-17')
})

test('audit: records are JSONL and drop non-allowlisted fields', async () => {
  const dir = await tempDir()
  try {
    const log = new AuditLog({ enabled: true, dir, maxFileBytes: 1_000_000, queueLimit: 10 })
    log.record({
      v: 1,
      ts: '2026-11-17T00:00:00.000Z',
      type: 'decision',
      tool: 'write',
      decision: 'allow',
      content: 'TOP SECRET',
      old_string: 'TOP SECRET',
    })
    await log.close()
    const files = await fsp.readdir(dir)
    assert.equal(files.length, 1)
    const text = await fsp.readFile(path.join(dir, files[0]), 'utf8')
    const record = JSON.parse(text.trim())
    assert.equal(record.tool, 'write')
    assert.equal(record.decision, 'allow')
    assert.equal(record.content, undefined)
    assert.equal(record.old_string, undefined)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('audit: queue limit drops records without throwing', async () => {
  const dir = await tempDir()
  try {
    const log = new AuditLog({ enabled: true, dir, maxFileBytes: 1_000_000, queueLimit: 1 })
    log.record({ type: 'decision', decision: 'allow' })
    log.record({ type: 'decision', decision: 'ask' })
    assert.equal(log.dropped, 1)
    await log.close()
    const files = await fsp.readdir(dir)
    const text = await fsp.readFile(path.join(dir, files[0]), 'utf8')
    assert.equal(text.trim().split('\n').length, 1)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('audit: max file size rotates into a second part', async () => {
  const dir = await tempDir()
  try {
    const log = new AuditLog({ enabled: true, dir, maxFileBytes: 120, queueLimit: 10 })
    log.record({ type: 'decision', decision: 'allow', tool: 'write' })
    log.record({ type: 'decision', decision: 'ask', tool: 'edit' })
    log.record({ type: 'decision', decision: 'deny', tool: 'write' })
    await log.close()
    const files = await fsp.readdir(dir)
    assert.equal(files.length, 2)
    assert.ok(files.includes(`audit-${localDate(new Date())}.jsonl`))
    assert.ok(files.includes(`audit-${localDate(new Date())}-02.jsonl`))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('audit: disabled writes nothing', async () => {
  const dir = await tempDir()
  try {
    const log = new AuditLog({ enabled: false, dir, maxFileBytes: 1_000_000, queueLimit: 10 })
    log.record({ type: 'decision', decision: 'allow' })
    await log.close()
    assert.deepEqual(await fsp.readdir(dir), [])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('audit: write failure warns once and does not throw', async () => {
  let warnings = 0
  const log = new AuditLog({
    enabled: true,
    dir: path.join(os.tmpdir(), `review-gate-unwritable-${process.pid}`, 'nested'),
    maxFileBytes: 1_000_000,
    queueLimit: 10,
    logger: { warn() { warnings += 1 } },
  })
  // Make the parent a file so mkdir fails.
  const blocker = path.join(os.tmpdir(), `review-gate-blocker-${process.pid}`)
  await fsp.writeFile(blocker, 'x')
  log.dir = path.join(blocker, 'nested')
  try {
    log.record({ type: 'decision', decision: 'allow' })
    log.record({ type: 'decision', decision: 'allow' })
    await log.close()
    assert.equal(warnings, 1)
  } finally {
    await fsp.rm(blocker, { force: true })
  }
})
