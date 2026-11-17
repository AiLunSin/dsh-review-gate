import assert from 'node:assert/strict'
import test from 'node:test'

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = hookCursor++
    if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial
    return [hookStates[index], (value) => { hookStates[index] = value }]
  },
  useEffect: () => {},
  useMemo: factory => factory(),
  useRef: () => ({ current: undefined }),
}

let hookCursor = 0
let hookStates = []
function resetHooks() {
  hookCursor = 0
  hookStates = []
}

const modules = []
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { modules.push(spec) },
  },
}
await import('../client.js')
const spec = modules[0]
assert.ok(spec, 'client.js must register a module')
const plugin = spec.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected client module: ${name}`)
})

test('client: module id and service injections', () => {
  assert.equal(spec.id, '@ailunsin/dsh-review-gate')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sidebarRightTabs'])
})

test('client: entry detection uses the configured globs', () => {
  const { isEntry } = plugin.__test
  const patterns = ['**/index.*', '**/server.*']
  assert.equal(isEntry('src/index.ts', patterns), true)
  assert.equal(isEntry('src/auth/index.ts', patterns), true)
  assert.equal(isEntry('src/server.js', patterns), true)
  assert.equal(isEntry('src/auth/login.ts', patterns), false)
})

test('client: groups files by directory and puts entry units first', () => {
  const files = [
    { path: 'src/auth/login.ts', display: 'src/auth/login.ts', added: 2, deleted: 9, index: 1 },
    { path: 'src/index.ts', display: 'src/index.ts', added: 5, deleted: 1, index: 0 },
    { path: 'src/utils/a.ts', display: 'src/utils/a.ts', added: 3, deleted: 0, index: 2 },
  ]
  const units = plugin.__test.buildUnits(files, { maxUnits: 5 })
  assert.equal(units.length, 3)
  assert.equal(units[0].key, 'src')
  assert.equal(units[0].entry, true)
  assert.ok(units[0].reasons.some(reason => reason.startsWith('entry:index.ts')))
  assert.equal(units[1].key, 'src/auth')
  assert.equal(units[2].key, 'src/utils')
})

test('client: merges overflow into one final unit', () => {
  const files = [
    { path: 'a/one.ts', added: 1, deleted: 0, index: 0 },
    { path: 'b/two.ts', added: 2, deleted: 0, index: 1 },
    { path: 'c/three.ts', added: 3, deleted: 0, index: 2 },
    { path: 'd/four.ts', added: 4, deleted: 0, index: 3 },
    { path: 'e/five.ts', added: 5, deleted: 0, index: 4 },
    { path: 'f/six.ts', added: 6, deleted: 0, index: 5 },
  ]
  const units = plugin.__test.buildUnits(files, { maxUnits: 3 })
  assert.equal(units.length, 3)
  assert.equal(units[2].key, '__merged__')
  assert.equal(units[2].merged, 4)
  assert.ok(units[2].reasons.some(reason => reason.startsWith('merged:')))
})

test('client: empty-state render consumes the documented props', () => {
  resetHooks()
  const tree = plugin.__test.ReviewGateTab({
    sessionId: 'session-1',
    useProjection: () => undefined,
    useTabInfo: () => ({ tab: { actions: { openResource() {} } } }),
    t: key => key,
  })
  assert.equal(tree.type, 'div')
  assert.match(JSON.stringify(tree), /emptyTitle/)
  assert.match(JSON.stringify(tree), /emptyBody/)
})

test('client: open hint requires a ready state with files', () => {
  const { shouldShowOpenHint } = plugin.__test
  assert.equal(shouldShowOpenHint('ready', [{ path: 'a.ts' }]), true)
  assert.equal(shouldShowOpenHint('ready', []), false)
  for (const status of ['idle', 'empty', 'loading', 'missing', 'error']) {
    assert.equal(shouldShowOpenHint(status, [{ path: 'a.ts' }]), false, `${status} must not render the open hint`)
  }
})

test('client: missing and error states are left-aligned with actionable text', () => {
  const { statusView } = plugin.__test
  const t = (key, params) => params === undefined ? key : `${key}:${params.message}`
  const missing = statusView('missing', t, '', () => {})
  assert.equal(missing.props.className, 'rg-state rg-state-left')
  assert.match(JSON.stringify(missing), /missingBody/)
  const error = statusView('error', t, 'boom', () => {})
  assert.equal(error.props.className, 'rg-state rg-state-left')
  assert.match(JSON.stringify(error), /error:boom/)
  assert.equal(statusView('loading', t, '', () => {}).props.className, 'rg-state')
  assert.equal(statusView('ready', t, '', () => {}), null)
})

test('client: scroll reset is safe for empty and mounted bodies', () => {
  const { resetBodyScroll } = plugin.__test
  const ref = { current: { scrollTop: 42 } }
  resetBodyScroll(ref)
  assert.equal(ref.current.scrollTop, 0)
  assert.doesNotThrow(() => resetBodyScroll({ current: null }))
})

test('client: apply registers the dictionary, tab type, and body', () => {
  const dictionaries = []
  const types = []
  const bodies = []
  const disposers = []
  const ctx = {
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    locale: {
      register(ns, dict) {
        dictionaries.push({ ns, dict })
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(key, callback) {
        callback()
        return () => {}
      },
      register(registration, component) {
        bodies.push({ registration, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        types.push(definition)
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].ns, 'reviewGate')
  assert.equal(dictionaries[0].dict.en.missingBody, 'Run a new turn that writes files to refresh this tab.')
  assert.equal(dictionaries[0].dict.zh.missingBody, '请跑一轮新的、会写文件的对话以刷新本页签。')
  assert.equal(types.length, 1)
  assert.equal(types[0].id, '@ailunsin/dsh-review-gate')
  assert.equal(types[0].kind, 'review-gate')
  assert.equal(types[0].guide[0].id, 'review-gate')
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].registration.name, 'sidebar.right.pane.tab')
  assert.equal(bodies[0].registration.key, '@ailunsin/dsh-review-gate')
  assert.equal(bodies[0].registration.locale, 'reviewGate')
  for (const dispose of disposers) dispose()
})
