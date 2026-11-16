import assert from 'node:assert/strict'
import test from 'node:test'
import { createReviewScopeCommand } from '../src/commands.js'
import {
  applyScopeEvent,
  describeScope,
  initialScopeState,
  parseScopeCommand,
  registerScopeProjection,
  scopeStateSchema,
} from '../src/scope.js'

const config = { scope: { default: ['config/**'], caseSensitive: false } }

test('scope: parse set, query, clear, and errors', () => {
  assert.deepEqual(parseScopeCommand('src/auth/**  !src/**/*.test.*'), {
    kind: 'set',
    globs: ['src/auth/**', '!src/**/*.test.*'],
  })
  assert.deepEqual(parseScopeCommand('   '), { kind: 'query' })
  assert.deepEqual(parseScopeCommand('clear'), { kind: 'clear' })
  assert.equal(parseScopeCommand('clear src/x').kind, 'error')
  assert.equal(parseScopeCommand('src/{a').kind, 'error')
})

test('scope: initial state comes from config', () => {
  assert.deepEqual(initialScopeState(config), { globs: ['config/**'], source: 'config' })
  assert.deepEqual(initialScopeState({ scope: { default: [] } }), { globs: [], source: 'none' })
})

test('scope: command/run updates the durable state', () => {
  const event = { type: 'command/run', seq: 7, data: { name: 'review-scope', args: 'src/auth/**' } }
  const next = applyScopeEvent({ globs: [], source: 'none' }, event)
  assert.deepEqual(next, { globs: ['src/auth/**'], source: 'command', declaredAtSeq: 7 })
})

test('scope: query keeps the previous state and reference', () => {
  const state = { globs: ['src/**'], source: 'command', declaredAtSeq: 2 }
  assert.equal(applyScopeEvent(state, { type: 'command/run', seq: 3, data: { name: 'review-scope', args: '' } }), state)
})

test('scope: clear produces a command-owned empty scope', () => {
  const state = { globs: ['src/**'], source: 'command', declaredAtSeq: 2 }
  assert.deepEqual(applyScopeEvent(state, {
    type: 'command/run',
    seq: 4,
    data: { name: 'review-scope', args: 'clear' },
  }), { globs: [], source: 'command', declaredAtSeq: 4 })
})

test('scope: invalid input and other commands do not change state', () => {
  const state = { globs: ['src/**'], source: 'command', declaredAtSeq: 2 }
  assert.equal(applyScopeEvent(state, {
    type: 'command/run',
    seq: 5,
    data: { name: 'review-scope', args: 'src/{a' },
  }), state)
  assert.equal(applyScopeEvent(state, {
    type: 'command/run',
    seq: 6,
    data: { name: 'compact', args: 'x' },
  }), state)
  assert.equal(applyScopeEvent(state, { type: 'turn/end', seq: 7 }), state)
})

test('scope: schema accepts valid state and rejects malformed state', () => {
  const state = scopeStateSchema.parse({ globs: ['src/**'], source: 'command', declaredAtSeq: 1 })
  assert.deepEqual(state, { globs: ['src/**'], source: 'command', declaredAtSeq: 1 })
  assert.throws(() => scopeStateSchema.parse({ globs: [1], source: 'command' }))
  assert.throws(() => scopeStateSchema.parse({ globs: [], source: 'other' }))
  assert.throws(() => scopeStateSchema.parse({ globs: [], source: 'none', declaredAtSeq: '1' }))
})

test('scope: registration calls the projection registry with the durable key', async () => {
  let registered
  const ctx = {
    get(service) {
      return service === 'sessionProjections'
        ? { register: async definition => { registered = definition; return { stateOf: () => definition.init() } } }
        : undefined
    },
    logger: { warn() {} },
  }
  const handle = await registerScopeProjection(ctx, config)
  assert.ok(handle)
  assert.equal(registered.key, 'review-gate/scope')
  assert.equal(registered.stateVersion, 1)
  assert.deepEqual(registered.init(), { globs: ['config/**'], source: 'config' })
  const state = registered.apply({ globs: [], source: 'none' }, {
    type: 'command/run',
    seq: 3,
    data: { name: 'review-scope', args: 'src/**' },
  })
  assert.deepEqual(state, { globs: ['src/**'], source: 'command', declaredAtSeq: 3 })
})

test('scope: registration degrades when the service is absent or rejects', async () => {
  assert.equal(await registerScopeProjection({ get: () => undefined }, config), undefined)
  const rejecting = {
    get: () => ({ register: async () => { throw new Error('conflict') } }),
    logger: { warn() {} },
  }
  assert.equal(await registerScopeProjection(rejecting, config), undefined)
})

test('scope: command echoes set, query, clear, and errors', () => {
  const state = { globs: ['src/auth/**'], source: 'command', declaredAtSeq: 1 }
  let handle = { stateOf: () => state }
  const command = createReviewScopeCommand({ config, locale: 'en', scopeHandle: handle })
  const set = command.handler({ agent: {}, rawInput: 'src/**' })
  assert.equal(set.kind, 'success')
  assert.match(set.text, /Scope updated \(1\)/)
  const query = command.handler({ agent: { session: {} }, rawInput: '' })
  assert.match(query.text, /Current scope \(command, 1\): src\/auth\/\*\*/)
  const clear = command.handler({ agent: {}, rawInput: 'clear' })
  assert.match(clear.text, /Scope cleared/)
  const error = command.handler({ agent: {}, rawInput: 'src/{a' })
  assert.equal(error.kind, 'error')
})

test('scope: command reports unavailable state without a projection', () => {
  const command = createReviewScopeCommand({ config, locale: 'zh', scopeHandle: undefined })
  const result = command.handler({ agent: {}, rawInput: 'src/**' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /范围状态不可用/)
})

test('scope: describeScope distinguishes none, config, and command', () => {
  assert.match(describeScope({ globs: [], source: 'none' }, 'en'), /No scope/)
  assert.equal(describeScope({ globs: ['src/**'], source: 'command' }, 'en'), 'src/**')
})
