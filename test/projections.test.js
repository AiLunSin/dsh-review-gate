import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHANGES_PROJECTION_KEY,
  META_PROJECTION_KEY,
  registerReviewProjections,
} from '../src/projections.js'
import { resolveConfig } from '../src/config.js'

const config = resolveConfig({})

function fakeRegistry() {
  const definitions = []
  return {
    definitions,
    async register(definition) {
      definitions.push(definition)
      return { stateOf: () => ({ seq: 0, turn: 0 }), dispose: async () => {} }
    },
  }
}

test('projections: registers client-visible changes and meta units', async () => {
  const registry = fakeRegistry()
  const ctx = {
    get(service) { return service === 'sessionProjections' ? registry : undefined },
    logger: { warn() {} },
  }
  const handles = await registerReviewProjections(ctx, config)
  assert.ok(handles.changesHandle)
  assert.ok(handles.metaHandle)
  assert.deepEqual(registry.definitions.map(definition => definition.key), [
    CHANGES_PROJECTION_KEY,
    META_PROJECTION_KEY,
  ])
  for (const definition of registry.definitions) assert.ok(definition.wire, 'projection must be client-visible')
})

test('projections: changes fold keeps the latest workspace/changes seq and turn', async () => {
  const registry = fakeRegistry()
  const ctx = { get: () => registry, logger: { warn() {} } }
  await registerReviewProjections(ctx, config)
  const changes = registry.definitions[0]
  const initial = changes.init()
  assert.deepEqual(initial, { seq: 0, turn: 0 })
  const next = changes.apply(initial, { type: 'workspace/changes', seq: 7, data: { turn: 2 } })
  assert.deepEqual(next, { seq: 7, turn: 2 })
  assert.equal(changes.apply(next, { type: 'tool/result', seq: 8 }), next)
  assert.equal(changes.apply(next, { type: 'workspace/changes', seq: 9, data: { turn: 0 } }), next)
  const wire = changes.wire.view(next)
  assert.equal(wire, next)
  assert.deepEqual(changes.wire.viewSchema.parse(wire), { seq: 7, turn: 2 })
})

test('projections: meta view is stable and carries the configured limits', async () => {
  const registry = fakeRegistry()
  const ctx = { get: () => registry, logger: { warn() {} } }
  await registerReviewProjections(ctx, config)
  const meta = registry.definitions[1]
  const state = meta.init()
  const first = meta.wire.view(state)
  const second = meta.wire.view(state)
  assert.equal(first, second)
  assert.equal(first, state)
  assert.equal(first.maxUnits, 5)
  assert.ok(first.entryPatterns.includes('**/index.*'))
})

test('projections: unavailable service degrades to no handles', async () => {
  assert.deepEqual(await registerReviewProjections({ get: () => undefined }, config), {})
  const rejecting = {
    get: () => ({ register: async () => { throw new Error('conflict') } }),
    logger: { warn() {} },
  }
  assert.deepEqual(await registerReviewProjections(rejecting, config), {})
})
