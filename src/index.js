/**
 * dsh-review-gate Host entry.
 *
 * A pre-write boundary gate for DeepSeek Harness. It answers three questions
 * before a file tool runs: is this path inside the declared scope, does the
 * change delete something sensitive, and is an approval channel available for
 * the decision? It never renders diffs, never adds model tools, and never stores
 * file contents.
 * @module dsh-review-gate
 */

import { AuditLog } from './audit.js'
import { createReviewScopeCommand } from './commands.js'
import { resolveConfig } from './config.js'
import { compileProtected } from './glob.js'
import {
  installApprovalObserver,
  installFsSafetyNet,
  installGuard,
  installPreExecute,
} from './interceptors.js'
import { resolveHostLocale } from './locale.js'
import { registerReviewProjections } from './projections.js'
import { resolveRuleset } from './rules.js'
import { registerScopeProjection } from './scope.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-review-gate'

/**
 * `tools` performs the gate; `sessionProjections` is required for the durable
 * `/review-scope` state. `commands`, `fs`, and `approval` are optional and are
 * consumed through `ctx.inject`/`ctx.get`, so a profile without them still gets
 * the configured default scope and rules.
 */
export const inject = ['tools', 'sessionProjections']

/**
 * @param {any} ctx Cordis Host context
 * @param {unknown} rawConfig profile config for this row
 * @returns {Promise<void>}
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const locale = resolveHostLocale(config)
  const audit = new AuditLog({
    enabled: config.audit.enabled,
    dir: config.audit.dir,
    maxFileBytes: config.audit.maxFileBytes,
    queueLimit: config.limits.auditQueue,
    logger: ctx.logger,
  })
  ctx.effect(() => () => {
    void audit.close()
  }, 'review-gate: audit sink')

  const ruleset = resolveRuleset(config)
  const protectedMatcher = compileProtected(config.protectedPaths, {
    caseSensitive: config.scope.caseSensitive,
  })

  const scopeHandle = await registerScopeProjection(ctx, config)
  if (scopeHandle === undefined) {
    audit.record({
      v: 1,
      ts: new Date().toISOString(),
      type: 'degraded',
      decision: 'allow',
      reason: 'scope-projection-unavailable',
    })
    ctx.logger?.warn?.('[review-gate] scope projection unavailable; falling back to configured scope/rules only')
  } else {
    ctx.inject(['commands'], (scope) => {
      const commands = scope.get('commands')
      if (commands === undefined || typeof commands.register !== 'function') return
      const definition = createReviewScopeCommand({ config, locale, scopeHandle })
      scope.effect(() => commands.register(definition), 'review-gate: /review-scope')
    })
  }

  const reviewProjections = await registerReviewProjections(ctx, config)
  if (reviewProjections.changesHandle === undefined) {
    audit.record({
      v: 1,
      ts: new Date().toISOString(),
      type: 'degraded',
      decision: 'allow',
      reason: 'review-projection-unavailable',
    })
  }

  const pendingAsks = new Map()
  const deps = {
    ctx,
    config,
    locale,
    scopeHandle,
    ruleset,
    protectedMatcher,
    audit,
    pendingAsks,
  }
  installPreExecute(deps)
  installFsSafetyNet(deps)
  if (ctx.tools !== undefined && typeof ctx.tools.guard === 'function') {
    installGuard(deps)
  }
  installApprovalObserver({ ctx, audit, pendingAsks })
}
