/**
 * Decision synthesis for one file-mutating call.
 *
 * Precedence: protected path deny > blocking rule deny > strict scope deny >
 * scope/rule ask > allow. An `ask` degrades according to
 * `onApprovalUnavailable` when the approval seam is absent or the session
 * policy is `never`.
 * @module dsh-review-gate/decide
 */

import path from 'node:path'
import { collectTargets, pathsOf, MAPPED_TOOLS } from './adapters.js'
import { compileProtected, relativePath } from './glob.js'
import { translate } from './locale.js'
import { evaluateRules, firstLineOf, headerIgnore } from './rules.js'
import { readScopeState, scopeMatcher } from './scope.js'
import { isPlainObject, normalizePath, splitLines } from './util.js'

export const ERROR_NAME = 'ReviewGateError'
export const ERROR_CODES = Object.freeze({
  protected: 'REVIEW_GATE_PROTECTED',
  scope: 'REVIEW_GATE_SCOPE_DENIED',
  rule: 'REVIEW_GATE_RULE_DENIED',
  approval: 'REVIEW_GATE_APPROVAL_UNAVAILABLE',
  internal: 'REVIEW_GATE_INTERNAL',
})

/**
 * Effective approval availability, using only public/stable-enough reads.
 * `overrideOf(session)` is the documented per-session read; `config.policy` is
 * the deployment fallback. Unknown shapes degrade to "available" so DSH keeps
 * its own fail-closed behavior.
 * @param {any} ctx
 * @param {any} agent
 * @returns {'available' | 'never' | 'absent'}
 */
export function approvalAvailability(ctx, agent) {
  if (agent === undefined || agent.session === undefined) return 'absent'
  const approval = ctx.get?.('approval')
  if (approval === undefined) return 'absent'
  try {
    let policy = typeof approval.overrideOf === 'function' ? approval.overrideOf(agent.session) : undefined
    if (policy === undefined && approval.config !== undefined) policy = approval.config.policy
    return policy === 'never' ? 'never' : 'available'
  } catch {
    return 'available'
  }
}

/**
 * @param {any} ctx
 * @param {any} exec
 * @returns {string}
 */
export function sessionCwd(ctx, exec) {
  const session = exec?.agent?.session
  const workingDirectory = ctx.get?.('workingDirectory')
  if (workingDirectory !== undefined && session !== undefined && typeof workingDirectory.get === 'function') {
    try {
      const cwd = workingDirectory.get(session)
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch {
      // Fall through to the Session header.
    }
  }
  const headerCwd = session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
  return process.cwd()
}

/**
 * Build a bounded, read-only file accessor over `ctx.fs`.
 * @param {any} ctx
 * @param {{ limits: { readFileBytes: number, readFileMs: number } }} config
 * @param {AbortSignal | undefined} execSignal
 * @returns {((absolutePath: string) => Promise<string | undefined>) | undefined}
 */
export function makeReadFile(ctx, config, execSignal) {
  const fs = ctx.get?.('fs')
  if (fs === undefined || typeof fs.resolve !== 'function' || typeof fs.stat !== 'function' || typeof fs.readText !== 'function') {
    return undefined
  }
  return async (absolutePath) => {
    let signal
    try {
      const timeout = AbortSignal.timeout(config.limits.readFileMs)
      signal = execSignal === undefined ? timeout : AbortSignal.any([execSignal, timeout])
    } catch {
      signal = execSignal
    }
    try {
      const target = await fs.resolve(absolutePath, { signal })
      const info = await fs.stat(target, signal)
      if (info === undefined || info.type !== 'file') return undefined
      if (typeof info.size === 'number' && info.size > config.limits.readFileBytes) return undefined
      const content = await fs.readText(target, signal)
      if (typeof content !== 'string') return undefined
      return Buffer.byteLength(content, 'utf8') <= config.limits.readFileBytes ? content : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * Fit rule-hit line numbers back onto the file when the adapter could not
 * provide them (edit/str_replace/apply_patch update hunks).
 * @param {any} target
 * @param {string} content
 * @returns {{ text: string, line: number }[]}
 */
export function remapDeletions(target, content) {
  if (target.deletions.every(deletion => deletion.line > 0)) return target.deletions
  if (target.source === 'edit' && typeof target.oldText === 'string' && target.oldText !== '') {
    const start = firstLineOf(content, target.oldText)
    if (start > 0) {
      const oldLines = splitLines(target.oldText)
      let cursor = 0
      return target.deletions.map((deletion) => {
        for (let index = cursor; index < oldLines.length; index += 1) {
          if (oldLines[index] === deletion.text) {
            cursor = index + 1
            return { text: deletion.text, line: start + index }
          }
        }
        return { text: deletion.text, line: 0 }
      })
    }
  }
  const fileLines = splitLines(content)
  let cursor = 0
  return target.deletions.map((deletion) => {
    for (let index = cursor; index < fileLines.length; index += 1) {
      if (fileLines[index] === deletion.text) {
        cursor = index + 1
        return { text: deletion.text, line: index + 1 }
      }
    }
    return deletion
  })
}

/**
 * Evaluate rules for one target, reading the file only when a hit exists (so
 * the common clean edit path stays cheap).
 * @param {any} target
 * @param {{
 *   ruleset: any,
 *   config: any,
 *   readFile?: (absolutePath: string) => Promise<string | undefined>,
 *   cwd: string,
 * }} deps
 * @returns {Promise<{ hits: any[], deleted: number, warnings: string[], skipped: boolean, content?: string }>}
 */
export async function evaluateTarget(target, deps) {
  if (target.deletions.length === 0) {
    return { hits: [], deleted: 0, warnings: [], skipped: false }
  }
  let content = target.content
  let result = evaluateRules({
    ruleset: deps.ruleset,
    toolName: target.toolName,
    absolutePath: target.absolutePath,
    cwd: deps.cwd,
    deletions: target.deletions,
    ruleMs: deps.config.limits.ruleMs,
  })
  if (result.hits.length === 0) return { ...result, content }
  if (content === undefined && deps.readFile !== undefined) {
    content = await deps.readFile(target.absolutePath)
  }
  if (content === undefined) return { ...result, content }
  const remapped = remapDeletions(target, content)
  result = evaluateRules({
    ruleset: deps.ruleset,
    toolName: target.toolName,
    absolutePath: target.absolutePath,
    cwd: deps.cwd,
    deletions: remapped,
    headerIgnore: headerIgnore(content),
    ruleMs: deps.config.limits.ruleMs,
  })
  return { ...result, content }
}

/**
 * @param {string} locale
 * @param {string} key
 * @param {Record<string, string | number>} params
 */
function text(locale, key, params) {
  return translate(locale === 'zh' ? 'zh' : 'en', key, params)
}

/**
 * Synthesize the decision.
 * @param {{
 *   ctx: any,
 *   config: any,
 *   locale: 'zh' | 'en',
 *   scopeHandle: any,
 *   ruleset: any,
 *   protectedMatcher: ReturnType<typeof compileProtected>,
 *   exec: any,
 * }} deps
 * @returns {Promise<{
 *   verdict: { kind: 'allow' } | { kind: 'ask', reason: string, displayReason: { en: string, zh: string } } | { kind: 'deny', reason: string, info: { name: string, code: string } },
 *   audit: Record<string, any>,
 * }>}
 */
export async function decide(deps) {
  const { ctx, config, locale, exec } = deps
  const started = performance.now()
  const toolName = typeof exec?.name === 'string' ? exec.name : ''
  const args = isPlainObject(exec?.arguments) ? exec.arguments : {}
  const cwd = sessionCwd(ctx, exec)
  const scopeState = readScopeState(deps.scopeHandle, exec?.agent?.session, config)
  const matcher = scopeMatcher(scopeState, config)
  const readFile = makeReadFile(ctx, config, exec?.signal)

  /** @param {Record<string, any>} audit */
  const finish = (audit) => ({
    audit: {
      v: 1,
      ts: new Date().toISOString(),
      sessionId: sessionIdOf(exec),
      tool: toolName,
      callId: typeof exec?.callId === 'string' ? exec.callId : undefined,
      scope: scopeState.globs,
      scopeSource: scopeState.source,
      ...audit,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
    },
  })

  if (!MAPPED_TOOLS.includes(toolName)) {
    return { verdict: { kind: 'allow' }, ...finish({ decision: 'allow', reason: 'unmapped-tool' }) }
  }

  const rawPaths = pathsOf(toolName, args)
  if (rawPaths.length === 0) {
    return { verdict: { kind: 'allow' }, ...finish({ decision: 'allow', reason: 'no-target' }) }
  }

  const targets = await collectTargets({
    toolName,
    args,
    cwd,
    readFile: config.rules.enabled ? readFile : undefined,
  })
  if (targets.length === 0) {
    return { verdict: { kind: 'allow' }, ...finish({ decision: 'allow', reason: 'no-target' }) }
  }

  for (const target of targets) {
    target.relativePath = relativePath(target.absolutePath, cwd)
  }

  const protectedTarget = targets.find(target => deps.protectedMatcher.matches(target.absolutePath, cwd))
  if (protectedTarget !== undefined) {
    const reason = `[review-gate] ${text(locale, 'deny.protected', { path: protectedTarget.relativePath })} (rule=RG-PROTECTED)`
    return {
      verdict: {
        kind: 'deny',
        reason,
        info: { name: ERROR_NAME, code: ERROR_CODES.protected },
      },
      ...finish({
        decision: 'deny',
        code: ERROR_CODES.protected,
        reason: 'protected-path',
        path: protectedTarget.relativePath,
        rules: ['RG-PROTECTED'],
      }),
    }
  }

  /** @type {any[]} */
  const outOfScope = config.scope.enforce && scopeState.globs.length > 0
    ? targets.filter(target => !matcher.inScope(target.absolutePath, cwd))
    : []

  /** @type {{ target: any, hits: any[], deleted: number, warnings: string[], skipped: boolean }[]} */
  const ruleResults = []
  if (config.rules.enabled) {
    for (const target of targets) {
      const result = await evaluateTarget(target, {
        ruleset: deps.ruleset,
        config,
        readFile,
        cwd,
      })
      ruleResults.push({ target, ...result })
    }
  }
  const allHits = ruleResults.flatMap(result => result.hits.map(hit => ({ ...hit, target: result.target })))
  const deleted = ruleResults.reduce((sum, result) => sum + result.deleted, 0)
  const warnings = [...new Set(ruleResults.flatMap(result => result.warnings))]
  const blocking = allHits.find(hit => hit.severity === 'block')
  if (blocking !== undefined) {
    const reason = `[review-gate] ${text(locale, 'deny.rule', {
      path: blocking.target.relativePath,
      rule: blocking.ruleId,
    })} (lines=${blocking.lines.join(',') || '?'})`
    return {
      verdict: {
        kind: 'deny',
        reason,
        info: { name: ERROR_NAME, code: ERROR_CODES.rule },
      },
      ...finish({
        decision: 'deny',
        code: ERROR_CODES.rule,
        reason: 'rule-block',
        path: blocking.target.relativePath,
        rules: allHits.map(hit => hit.ruleId),
        deleted,
        snippetHash: blocking.snippetHash,
        warnings,
      }),
    }
  }

  const scopeViolation = outOfScope.length > 0
  if (scopeViolation && config.scope.strict) {
    const strictTarget = outOfScope[0]
    const reason = `[review-gate] ${text(locale, 'deny.scope', {
      path: strictTarget.relativePath,
      scope: scopeState.globs.join('  '),
    })}`
    return {
      verdict: {
        kind: 'deny',
        reason,
        info: { name: ERROR_NAME, code: ERROR_CODES.scope },
      },
      ...finish({
        decision: 'deny',
        code: ERROR_CODES.scope,
        reason: 'scope-denied',
        path: strictTarget.relativePath,
        rules: allHits.map(hit => hit.ruleId),
        deleted,
        ...warnings.length > 0 ? { warnings } : {},
      }),
    }
  }
  const askHits = allHits.filter(hit => hit.severity === 'ask')
  const needsAsk = scopeViolation || askHits.length > 0
  if (!needsAsk) {
    return {
      verdict: { kind: 'allow' },
      ...finish({
        decision: 'allow',
        reason: scopeState.globs.length === 0 ? 'unscoped-allow' : 'in-scope-allow',
        path: targets[0].relativePath,
        rules: [],
        deleted,
        unscoped: scopeState.globs.length === 0,
        ...warnings.length > 0 ? { warnings } : {},
      }),
    }
  }

  const primaryTarget = scopeViolation ? outOfScope[0] : askHits[0].target
  const primaryPath = primaryTarget.relativePath
  const primaryRule = askHits[0]?.ruleId
  const scopeText = scopeState.globs.join('  ') || text(locale, 'command.unscoped')
  const rulesText = [...new Set(askHits.map(hit => hit.ruleId))].join(',')
  const auditReason = [
    `[review-gate] ${scopeViolation ? 'scope-violation' : 'rule-ask'}`,
    `path=${primaryPath}`,
    ...scopeViolation ? [`scope=${scopeText}`] : [],
    `tool=${toolName}`,
    ...primaryRule === undefined ? [] : [`rules=${rulesText}`],
  ].join(' ')

  const displayReason = scopeViolation && askHits.length > 0
    ? {
      en: translate('en', 'display.mixed', {
        path: primaryPath,
        scope: scopeText,
        rules: rulesText,
      }),
      zh: translate('zh', 'display.mixed', {
        path: primaryPath,
        scope: scopeText,
        rules: rulesText,
      }),
    }
    : scopeViolation
      ? {
        en: translate('en', 'display.scope', { path: primaryPath, scope: scopeText }),
        zh: translate('zh', 'display.scope', { path: primaryPath, scope: scopeText }),
      }
      : {
        en: translate('en', 'display.rule', {
          path: primaryPath,
          rule: rulesText,
          count: deleted,
        }),
        zh: translate('zh', 'display.rule', {
          path: primaryPath,
          rule: rulesText,
          count: deleted,
        }),
      }

  const availability = approvalAvailability(ctx, exec?.agent)
  if (availability !== 'available') {
    if (config.onApprovalUnavailable === 'allow') {
      return {
        verdict: { kind: 'allow' },
        ...finish({
          decision: 'allow',
          reason: 'approval-unavailable-allow',
          path: primaryPath,
          rules: askHits.map(hit => hit.ruleId),
          deleted,
          approval: availability,
          degraded: true,
          warnings,
        }),
      }
    }
    const kind = scopeViolation && askHits.length === 0 ? 'scope' : 'rule'
    const reason = `${auditReason} — ${text(locale, 'deny.approval', {
      kind: kind === 'scope' ? (locale === 'zh' ? '越界写入' : 'out-of-scope write') : (locale === 'zh' ? '敏感删除' : 'sensitive deletion'),
    })}`
    return {
      verdict: {
        kind: 'deny',
        reason,
        info: { name: ERROR_NAME, code: ERROR_CODES.approval },
      },
      ...finish({
        decision: 'deny',
        code: ERROR_CODES.approval,
        reason: 'approval-unavailable-deny',
        path: primaryPath,
        rules: askHits.map(hit => hit.ruleId),
        deleted,
        approval: availability,
        warnings,
      }),
    }
  }

  return {
    verdict: {
      kind: 'ask',
      reason: auditReason,
      displayReason,
    },
    ...finish({
      decision: 'ask',
      reason: scopeViolation ? 'scope-violation' : 'rule-ask',
      path: primaryPath,
      rules: askHits.map(hit => hit.ruleId),
      deleted,
      approval: availability,
      ...warnings.length > 0 ? { warnings } : {},
    }),
  }
}

/** @param {any} exec @returns {string | undefined} */
function sessionIdOf(exec) {
  const session = exec?.agent?.session
  if (session === undefined) return undefined
  return typeof session.id === 'string' ? session.id : session.header?.id
}

/**
 * Synchronous protected-path guard. Uses the adapter's declared paths only; it
 * must never read files or await.
 * @param {any} exec
 * @param {string} cwd
 * @param {ReturnType<typeof compileProtected>} protectedMatcher
 * @returns {{ reason: string, info: { name: string, code: string } } | undefined}
 */
export function guardDecision(exec, cwd, protectedMatcher) {
  if (!MAPPED_TOOLS.includes(exec?.name)) return undefined
  const args = isPlainObject(exec?.arguments) ? exec.arguments : {}
  for (const rawPath of pathsOf(exec.name, args)) {
    const absolutePath = path.resolve(cwd, rawPath)
    if (protectedMatcher.matches(absolutePath, cwd)) {
      const relative = relativePath(absolutePath, cwd)
      return {
        reason: `[review-gate] protected path: ${normalizePath(relative)} (rule=RG-PROTECTED)`,
        info: { name: ERROR_NAME, code: ERROR_CODES.protected },
      }
    }
  }
  return undefined
}
