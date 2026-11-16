/**
 * Runtime interception: the pre-execute gate, the fs/* safety net, the
 * synchronous protected-path guard, and the approval-outcome audit observer.
 * @module dsh-review-gate/interceptors
 */

import path from 'node:path'
import { MAPPED_TOOLS } from './adapters.js'
import {
  approvalAvailability,
  decide,
  ERROR_CODES,
  ERROR_NAME,
  guardDecision,
  sessionCwd,
} from './decide.js'
import { relativePath } from './glob.js'
import { translate } from './locale.js'
import { readScopeState, scopeMatcher } from './scope.js'
import { isAbsolutePath } from './util.js'

/**
 * Race a promise against the pre-execute budget. A timed-out computation keeps
 * running but its result is ignored; the call is allowed and audited as degraded.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<{ timedOut: false, value: T } | { timedOut: true }>}
 */
export function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ timedOut: true })
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ timedOut: false, value })
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * @param {{
 *   ctx: any,
 *   config: any,
 *   locale: 'zh' | 'en',
 *   scopeHandle: any,
 *   ruleset: any,
 *   protectedMatcher: any,
 *   audit: any,
 *   pendingAsks: Map<string, any>,
 * }} deps
 */
export function installPreExecute(deps) {
  const { ctx, config, locale, audit } = deps
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (!config.enabled) return next()
    if (!MAPPED_TOOLS.includes(exec?.name)) return next()
    if (exec.signal?.aborted) return next()
    try {
      const raced = await withTimeout(decide({ ...deps, exec }), config.limits.preExecuteMs)
      if (raced.timedOut) {
        audit.record({
          v: 1,
          ts: new Date().toISOString(),
          type: 'decision',
          sessionId: sessionIdOf(exec),
          tool: exec.name,
          callId: exec.callId,
          decision: config.onInternalError === 'deny' ? 'deny' : 'allow',
          reason: 'deadline-exceeded',
          degraded: true,
        })
        return config.onInternalError === 'deny'
          ? {
            kind: 'deny',
            reason: `[review-gate] decision exceeded ${config.limits.preExecuteMs}ms; denied by config`,
            info: { name: ERROR_NAME, code: ERROR_CODES.internal },
          }
          : next()
      }
      const { verdict, audit: record } = raced.value
      audit.record({ ...record, type: 'decision' })
      if (verdict.kind === 'ask') {
        if (typeof exec.callId === 'string') {
          deps.pendingAsks.set(exec.callId, {
            tool: exec.name,
            sessionId: sessionIdOf(exec),
            at: Date.now(),
          })
          if (deps.pendingAsks.size > 512) {
            const oldest = deps.pendingAsks.keys().next().value
            if (oldest !== undefined) deps.pendingAsks.delete(oldest)
          }
        }
        return { kind: 'ask', reason: verdict.reason, displayReason: verdict.displayReason }
      }
      if (verdict.kind === 'deny') {
        return { kind: 'deny', reason: verdict.reason, info: verdict.info }
      }
      return next()
    } catch (error) {
      audit.record({
        v: 1,
        ts: new Date().toISOString(),
        type: 'decision',
        sessionId: sessionIdOf(exec),
        tool: exec.name,
        callId: exec.callId,
        decision: config.onInternalError === 'deny' ? 'deny' : 'allow',
        reason: 'internal-error',
        degraded: true,
      })
      ctx.logger?.warn?.('[review-gate] decision failed; applying onInternalError:', error)
      return config.onInternalError === 'deny'
        ? {
          kind: 'deny',
          reason: `[review-gate] internal decision error (${error instanceof Error ? error.message : String(error)})`,
          info: { name: ERROR_NAME, code: ERROR_CODES.internal },
        }
        : next()
    }
  }), 'review-gate: tools/pre-execute')
}

/**
 * Install the fs/* safety net for tools the pre-execute gate does not map.
 * `prepend` keeps this listener ahead of the built-in observed-state policy,
 * which occupies the same single-slot waterfall.
 * @param {{
 *   ctx: any,
 *   config: any,
 *   locale: 'zh' | 'en',
 *   scopeHandle: any,
 *   protectedMatcher: any,
 *   audit: any,
 * }} deps
 */
export function installFsSafetyNet(deps) {
  const { ctx, config, locale, scopeHandle, protectedMatcher, audit } = deps
  const check = (verb, target, actor) => {
    const actorName = typeof actor?.name === 'string' ? actor.name : undefined
    if (actorName !== undefined && MAPPED_TOOLS.includes(actorName)) return undefined
    if (typeof target?.displayPath !== 'string') return undefined
    const displayPath = target.displayPath
    const isLocal = isAbsolutePath(displayPath)
    const cwd = actor?.agent !== undefined ? sessionCwd(ctx, actor) : process.cwd()
    const absolute = isLocal ? displayPath : path.resolve(cwd, displayPath)
    const relative = isLocal ? relativePath(absolute, cwd) : null
    if (protectedMatcher.matches(absolute, cwd)) {
      return {
        code: ERROR_CODES.protected,
        message: `[review-gate] ${translate(locale, 'deny.protected', { path: relative ?? displayPath })} (rule=RG-PROTECTED)`,
      }
    }
    if (relative === null) return undefined
    if (!config.scope.enforce) return undefined
    const state = readScopeState(scopeHandle, actor?.agent?.session, config)
    if (state.globs.length === 0) return undefined
    const matcher = scopeMatcher(state, config)
    if (matcher.inScope(absolute, cwd)) return undefined
    return {
      code: ERROR_CODES.scope,
      message: `[review-gate] ${translate(locale, 'deny.scope', {
        path: relative,
        scope: state.globs.join('  '),
      })} (fs-intent=${verb})`,
    }
  }
  const listener = (verb) => async (target, actor, next) => {
    if (actor?.signal?.aborted) return next()
    try {
      const denial = check(verb, target, actor)
      if (denial === undefined) {
        audit.record({
          v: 1,
          ts: new Date().toISOString(),
          type: 'fs-intent',
          decision: 'allow',
          tool: typeof actor?.name === 'string' ? actor.name : undefined,
          sessionId: actor?.agent?.session === undefined ? undefined : sessionIdOf({ agent: actor.agent }),
          path: typeof target?.displayPath === 'string' ? target.displayPath : undefined,
          reason: 'safety-net',
        })
        return next()
      }
      audit.record({
        v: 1,
        ts: new Date().toISOString(),
        type: 'fs-intent',
        decision: 'deny',
        code: denial.code,
        tool: typeof actor?.name === 'string' ? actor.name : undefined,
        sessionId: actor?.agent?.session === undefined ? undefined : sessionIdOf({ agent: actor.agent }),
        path: typeof target?.displayPath === 'string' ? target.displayPath : undefined,
        reason: `fs-${verb}`,
      })
      const error = new Error(denial.message)
      error.name = ERROR_NAME
      error.code = denial.code
      throw error
    } catch (error) {
      if (error instanceof Error && error.name === ERROR_NAME) throw error
      ctx.logger?.warn?.('[review-gate] fs safety net failed; allowing the mutation:', error)
      return next()
    }
  }
  ctx.effect(() => ctx.on('fs/write-intent', listener('write'), { prepend: true }), 'review-gate: fs/write-intent')
  ctx.effect(() => ctx.on('fs/edit-intent', listener('edit'), { prepend: true }), 'review-gate: fs/edit-intent')
  ctx.effect(() => ctx.on('fs/delete-intent', listener('delete'), { prepend: true }), 'review-gate: fs/delete-intent')
}

/**
 * Synchronous protected-path guard, registered after the observed-state policy
 * and independent of listener order.
 * @param {{ ctx: any, config: any, locale: 'zh' | 'en', protectedMatcher: any }} deps
 */
export function installGuard(deps) {
  const { ctx, protectedMatcher } = deps
  ctx.effect(() => ctx.tools.guard(exec => guardDecision(exec, sessionCwd(ctx, exec), protectedMatcher)), 'review-gate: tools.guard()')
}

/**
 * Correlate our own `ask` with `approval/decided` and append one outcome record.
 * @param {{ ctx: any, audit: any, pendingAsks: Map<string, any> }} deps
 */
export function installApprovalObserver(deps) {
  const { ctx, audit, pendingAsks } = deps
  /** @type {Map<string, { callId?: string, toolName?: string, sessionId?: string }>} */
  const asked = new Map()
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event?.type === 'approval/asked') {
      const id = typeof event.data?.id === 'string' ? event.data.id : String(event.data?.id ?? '')
      if (id === '') return
      asked.set(id, {
        callId: typeof event.data?.callId === 'string' ? event.data.callId : undefined,
        toolName: typeof event.data?.toolName === 'string' ? event.data.toolName : undefined,
        sessionId: typeof session?.id === 'string' ? session.id : session?.header?.id,
      })
      if (asked.size > 512) {
        const oldest = asked.keys().next().value
        if (oldest !== undefined) asked.delete(oldest)
      }
      return
    }
    if (event?.type !== 'approval/decided') return
    const id = typeof event.data?.id === 'string' ? event.data.id : String(event.data?.id ?? '')
    const entry = asked.get(id)
    if (entry === undefined) return
    asked.delete(id)
    if (entry.callId === undefined || !pendingAsks.has(entry.callId)) return
    pendingAsks.delete(entry.callId)
    audit.record({
      v: 1,
      ts: new Date().toISOString(),
      type: 'approval',
      sessionId: entry.sessionId,
      tool: entry.toolName,
      toolName: entry.toolName,
      callId: entry.callId,
      requestId: id,
      decision: event.data?.outcome,
      outcome: event.data?.outcome,
    })
  }), 'review-gate: approval audit')
}

/**
 * Best-effort availability probe used in tests and documentation.
 * @param {any} ctx
 * @param {any} exec
 */
export function availabilityOf(ctx, exec) {
  return approvalAvailability(ctx, exec?.agent)
}

/** @param {any} exec */
function sessionIdOf(exec) {
  const session = exec?.agent?.session
  if (session === undefined) return undefined
  return typeof session.id === 'string' ? session.id : session.header?.id
}
