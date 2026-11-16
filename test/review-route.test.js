import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { resolveConfig } from '../src/config.js'
import { handleReviewRequest } from '../src/review-route.js'

const cwd = path.resolve('/w')
const abs = value => path.resolve(cwd, value)

function fakeContext({ files = {}, dirs = {}, summary, diff } = {}) {
  return {
    get(service) {
      if (service === 'workspaceChanges') {
        return {
          summary: () => summary,
          diff: async (_sessionId, _seq, index) => diff?.[index],
        }
      }
      if (service === 'fs') {
        return {
          resolve: async (value, opts) => {
            const absolute = path.resolve(opts?.cwd ?? cwd, value)
            return { displayPath: absolute, targetKey: absolute }
          },
          stat: async target => {
            if (Object.hasOwn(files, target.targetKey)) {
              return { type: 'file', size: files[target.targetKey].length }
            }
            if (Object.hasOwn(dirs, target.targetKey)) return { type: 'directory' }
            return undefined
          },
          readText: async target => files[target.targetKey],
          listDir: async target => dirs[target.targetKey] ?? [],
        }
      }
      return undefined
    },
  }
}

const summary = {
  turn: 2,
  cwd,
  files: [
    { path: 'src/index.ts', display: 'src/index.ts', added: 2, deleted: 0 },
    { path: 'src/auth/login.ts', display: 'src/auth/login.ts', added: 1, deleted: 1 },
  ],
  total: 2,
  added: 3,
  deleted: 1,
}

function request(seq = 5, sessionId = 'session-1') {
  return new Request(`http://127.0.0.1/api/review-gate.units?sessionId=${sessionId}&seq=${seq}`)
}

test('review route: graph units + ADR hint from an explicit scope', async () => {
  const files = {
    [abs('CLAUDE.md')]: '- Applies to: src/auth/** — auth must call `hasPermission(`\n',
    [abs('src/index.ts')]: "import { login } from './auth/login'\n",
    [abs('src/auth/login.ts')]: 'export function login() { if (!user.hasPermission("admin")) return deny() }\n',
  }
  const ctx = fakeContext({
    files,
    summary,
    diff: {
      1: { kind: 'text', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-if (!user.hasPermission("admin")) return deny()'] }] },
    },
  })
  const config = resolveConfig({})
  const response = await handleReviewRequest({ ctx, config, request: request() })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.mode, 'graph')
  assert.equal(payload.units.length, 1)
  assert.equal(payload.units[0].entry, true)
  assert.equal(payload.units[0].files.length, 2)
  assert.ok(payload.units[0].reasons.some(reason => reason.startsWith('imports:')))
  assert.equal(payload.hints.length, 1)
  assert.equal(payload.hints[0].decisionId, 'DOC-CLAUDE.md:1')
  assert.equal(payload.hints[0].file, 'src/auth/login.ts')
})

test('review route: rejects malformed coordinates', async () => {
  const ctx = fakeContext({ summary })
  const config = resolveConfig({})
  const missing = await handleReviewRequest({
    ctx,
    config,
    request: new Request('http://127.0.0.1/api/review-gate.units?sessionId=x'),
  })
  assert.equal(missing.status, 400)
  const noChanges = await handleReviewRequest({
    ctx: { get: () => undefined },
    config,
    request: request(),
  })
  assert.equal(noChanges.status, 503)
  const notFound = await handleReviewRequest({
    ctx: fakeContext({ summary: undefined }),
    config,
    request: request(),
  })
  assert.equal(notFound.status, 404)
})

test('review route: falls back to directory units without an fs service', async () => {
  const ctx = {
    get(service) {
      if (service === 'workspaceChanges') return { summary: () => summary, diff: async () => undefined }
      return undefined
    },
  }
  const config = resolveConfig({ review: { importGraph: false, decisionSources: [] } })
  const response = await handleReviewRequest({ ctx, config, request: request() })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.mode, 'directory')
  assert.equal(payload.units.length, 2)
  assert.deepEqual(payload.hints, [])
})
