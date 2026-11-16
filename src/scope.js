/**
 * Scope declaration state, command parsing, and the session projection.
 *
 * The scope is derived from the session log, not from plugin-private storage:
 * `/review-scope` is recorded as a durable `command/run` event, so a refresh,
 * resume, or fork reconstructs the same scope.
 *
 * @module dsh-review-gate/scope
 */

import { compileScope, GlobError, splitScopeTokens } from './glob.js'
import { isPlainObject, unique } from './util.js'

export const SCOPE_PROJECTION_KEY = 'review-gate/scope'
export const SCOPE_COMMAND = 'review-scope'
export const SCOPE_STATE_VERSION = 1

/** @typedef {'command' | 'config' | 'none'} ScopeSource */

/**
 * @typedef {{
 *   globs: string[],
 *   source: ScopeSource,
 *   declaredAtSeq?: number,
 * }} ScopeState
 */

/**
 * Parse `/review-scope` input.
 * @param {string} rawInput
 * @returns {{ kind: 'query' } | { kind: 'clear' } | { kind: 'set', globs: string[] } | { kind: 'error', message: string }}
 */
export function parseScopeCommand(rawInput) {
  const input = String(rawInput ?? '').trim()
  if (input === '') return { kind: 'query' }
  const tokens = splitScopeTokens(input)
  if (tokens.length === 0) return { kind: 'query' }
  if (tokens.includes('clear')) {
    return tokens.length === 1
      ? { kind: 'clear' }
      : { kind: 'error', message: 'clear must be used alone: /review-scope clear' }
  }
  /** @type {string[]} */
  const globs = []
  for (const token of tokens) {
    try {
      // Validate now so a bad command records an error instead of a broken scope.
      compileScope([token])
    } catch (error) {
      return { kind: 'error', message: error instanceof GlobError ? error.message : String(error) }
    }
    globs.push(token)
  }
  return { kind: 'set', globs: unique(globs) }
}

/**
 * Create the initial state for a Session.
 * @param {{ scope: { default: string[] } }} config
 * @returns {ScopeState}
 */
export function initialScopeState(config) {
  const globs = unique(config.scope.default.map(value => String(value)))
  return globs.length > 0
    ? { globs, source: 'config' }
    : { globs: [], source: 'none' }
}

/**
 * Apply one committed session event to the scope state. Pure and synchronous.
 * @param {ScopeState} state
 * @param {any} event
 * @returns {ScopeState}
 */
export function applyScopeEvent(state, event) {
  if (!event || event.type !== 'command/run') return state
  if (event.data?.name !== SCOPE_COMMAND) return state
  const parsed = parseScopeCommand(event.data.args ?? '')
  if (parsed.kind === 'query' || parsed.kind === 'error') return state
  const globs = parsed.kind === 'clear' ? [] : parsed.globs
  const same = globs.length === state.globs.length
    && globs.every((glob, index) => glob === state.globs[index])
  if (same && state.source === 'command') return state
  return {
    globs,
    source: 'command',
    declaredAtSeq: typeof event.seq === 'number' ? event.seq : state.declaredAtSeq,
  }
}

/** Minimal structural schema; the projection registry only requires `parse`. */
export const scopeStateSchema = {
  /**
   * @param {unknown} value
   * @returns {ScopeState}
   */
  parse(value) {
    if (!isPlainObject(value)) throw new TypeError('review-gate scope state must be an object')
    if (!Array.isArray(value.globs) || value.globs.some(glob => typeof glob !== 'string')) {
      throw new TypeError('review-gate scope state.globs must be string[]')
    }
    if (value.source !== 'command' && value.source !== 'config' && value.source !== 'none') {
      throw new TypeError('review-gate scope state.source is invalid')
    }
    if (value.declaredAtSeq !== undefined && typeof value.declaredAtSeq !== 'number') {
      throw new TypeError('review-gate scope state.declaredAtSeq must be a number')
    }
    return {
      globs: [...value.globs],
      source: value.source,
      ...value.declaredAtSeq === undefined ? {} : { declaredAtSeq: value.declaredAtSeq },
    }
  },
}

/**
 * Register the scope projection.
 * @param {any} ctx
 * @param {{ scope: { default: string[] } }} config
 * @returns {Promise<any | undefined>} projection handle, or undefined when the service is absent/rejects
 */
export async function registerScopeProjection(ctx, config) {
  const registry = ctx.get?.('sessionProjections')
  if (registry === undefined || typeof registry.register !== 'function') return undefined
  try {
    return await registry.register({
      key: SCOPE_PROJECTION_KEY,
      stateVersion: SCOPE_STATE_VERSION,
      stateSchema: scopeStateSchema,
      init: () => initialScopeState(config),
      apply: (state, event) => applyScopeEvent(state, event),
    })
  } catch (error) {
    ctx.logger?.warn?.('[review-gate] scope projection unavailable:', error)
    return undefined
  }
}

/**
 * Read the current scope state for a Session.
 * @param {any} handle
 * @param {any} session
 * @param {{ scope: { default: string[] } }} config
 * @returns {ScopeState}
 */
export function readScopeState(handle, session, config) {
  if (handle !== undefined && session !== undefined) {
    try {
      return handle.stateOf(session)
    } catch {
      // A disposed or foreign session degrades to the configured default.
    }
  }
  return initialScopeState(config)
}

/**
 * Compile the declared scope for matching.
 * @param {ScopeState} state
 * @param {{ scope: { caseSensitive: boolean } }} config
 */
export function scopeMatcher(state, config) {
  return compileScope(state.globs, { caseSensitive: config.scope.caseSensitive })
}

/**
 * Human-readable scope summary for command echoes and approval text.
 * @param {ScopeState} state
 * @param {'en' | 'zh'} locale
 * @returns {string}
 */
export function describeScope(state, locale) {
  if (state.source === 'none' || state.globs.length === 0) {
    return locale === 'zh' ? '未声明范围（只审计，不拦截）' : 'No scope declared (audit only)'
  }
  return state.globs.join('  ')
}
