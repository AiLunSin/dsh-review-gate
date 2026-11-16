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
import { resolveRuleset } from './rules.js'
import { registerScopeProjection } from './scope.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-review-gate'

/**
 * `tools` is the only hard dependency: the gate lives on its event/seam.
 * Everything else (projections, commands, fs, approval) is optional and
 * degrades to a narrower capability instead of blocking activation.
 */
export const inject = ['tools']

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

  const commands = ctx.get?.('commands')
  if (scopeHandle !== undefined && commands !== undefined && typeof commands.register === 'function') {
    const definition = createReviewScopeCommand({ config, locale, scopeHandle })
    ctx.effect(() => commands.register(definition), 'review-gate: /review-scope')
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
