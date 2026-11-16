/**
 * Minimal fake Cordis Host used by tests. It implements only the seams this
 * plugin consumes and records registrations so tests can assert cleanup.
 */

import path from 'node:path'

/**
 * @param {{
 *   cwd?: string,
 *   approval?: any,
 *   scopeState?: { globs: string[], source: 'command' | 'config' | 'none' },
 *   files?: Record<string, string>,
 * }} [options]
 */
export function createFakeHost(options = {}) {
  const cwd = options.cwd ?? path.resolve('/w')
  const fileMap = new Map(Object.entries(options.files ?? {}).map(([key, value]) => [path.resolve(cwd, key), value]))
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const disposers = []
  /** @type {Function[]} */
  const guards = []
  /** @type {any[]} */
  const commands = []
  const routes = []
  let scopeState = options.scopeState ?? { globs: [], source: 'none' }
  let projectionDefinition
  const projectionDefinitions = []

  const ctx = {
    get(service) {
      if (service === 'workingDirectory') return { get: () => cwd }
      if (service === 'approval') return options.approval
      if (service === 'commands') {
        return {
          register(definition) {
            commands.push(definition)
            return () => {
              const index = commands.indexOf(definition)
              if (index >= 0) commands.splice(index, 1)
            }
          },
        }
      }
      if (service === 'connection' && options.connection === true) {
        return {
          fetch: {
            register(route) {
              routes.push(route)
              return async () => {}
            },
          },
        }
      }
      if (service === 'sessionProjections') {
        return {
          async register(definition) {
            if (projectionDefinition === undefined) projectionDefinition = definition
            projectionDefinitions.push(definition)
            return {
              stateOf: () => scopeState,
              dispose: async () => {},
            }
          },
        }
      }
      if (service === 'fs') {
        return {
          resolve: async (value, opts) => {
            const absolute = path.resolve(opts?.cwd ?? cwd, value)
            return { targetKey: absolute, displayPath: absolute }
          },
          stat: async target => fileMap.has(target.targetKey)
            ? { type: 'file', size: fileMap.get(target.targetKey).length }
            : undefined,
          readText: async target => fileMap.get(target.targetKey),
        }
      }
      return undefined
    },
    on(name, listener, opts) {
      const entries = listeners.get(name) ?? []
      if (opts?.prepend) entries.unshift(listener)
      else entries.push(listener)
      listeners.set(name, entries)
      return () => {
        const index = entries.indexOf(listener)
        if (index >= 0) entries.splice(index, 1)
      }
    },
    inject(dependencies, callback) {
      if (!dependencies.every(name => ctx.get(name) !== undefined)) return () => {}
      const dispose = callback(ctx)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    tools: {
      guard(fn) {
        guards.push(fn)
        return () => {
          const index = guards.indexOf(fn)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
    logger: {
      warn() {},
      info() {},
      debug() {},
    },
  }

  return {
    ctx,
    cwd,
    commands,
    routes,
    guards,
    listeners,
    get projectionDefinition() { return projectionDefinition },
    get projectionDefinitions() { return projectionDefinitions },
    setScope(next) { scopeState = next },
    getScope() { return scopeState },
    listenersFor(name) { return listeners.get(name) ?? [] },
    dispose() {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try { dispose() } catch {}
      }
      listeners.clear()
      guards.length = 0
      commands.length = 0
      routes.length = 0
    },
    async runPreExecute(exec) {
      const entries = [...this.listenersFor('tools/pre-execute')]
      let index = 0
      const next = async () => ({ kind: 'allow' })
      return entries[index++](exec, next)
    },
    async runFsIntent(verb, target, actor) {
      const entries = [...this.listenersFor(`fs/${verb}-intent`)]
      let called = false
      const next = () => {
        called = true
        return undefined
      }
      const value = await entries[0](target, actor, next)
      return { value, nextCalled: called }
    },
  }
}
