/**
 * Deterministic sensitive-deletion rules.
 *
 * Only removed lines are matched, never added lines. Matching happens after the
 * adapter extracts deletions; blank and comment lines are skipped by heuristic.
 * No LLM and no file contents leave this module.
 * @module dsh-review-gate/rules
 */

import { compileScope } from './glob.js'
import { isCommentOrBlank, sha256Prefix } from './util.js'

export const RULESET_VERSION = 1

/** Default rule set. `ask` is deliberate: a false positive stays reversible. */
export const DEFAULT_RULES = Object.freeze([
  Object.freeze({
    id: 'RG-AUTH-001',
    title: 'Authentication/authorization check removed',
    severity: 'ask',
    appliesTo: ['write', 'edit', 'apply_patch', 'str_replace_editor'],
    patterns: [
      String.raw`hasPermission\s*\(`,
      String.raw`isAuthori[sz]ed\s*\(`,
      String.raw`requireRole\s*\(`,
      String.raw`checkAuth(?:entication)?\s*\(`,
      String.raw`\bauthenticate\s*\(`,
      String.raw`\bauthori[sz]e\s*\(`,
    ],
    ignorePaths: [],
  }),
  Object.freeze({
    id: 'RG-GUARD-002',
    title: 'Guard/early-return removed',
    severity: 'ask',
    appliesTo: ['write', 'edit', 'apply_patch', 'str_replace_editor'],
    patterns: [
      String.raw`\bthrow\s+new\s+(?:Unauthorized|Forbidden|Permission)`,
      String.raw`\bif\s*\(\s*!`,
      String.raw`\breturn\s+(?:res\.)?status\(\s*(?:401|403)\s*\)`,
    ],
    ignorePaths: [],
  }),
  Object.freeze({
    id: 'RG-VALID-003',
    title: 'Input validation removed',
    severity: 'ask',
    appliesTo: ['write', 'edit', 'apply_patch', 'str_replace_editor'],
    patterns: [
      String.raw`\b(?:validate|sanitize|escape|assert)\w*\s*\(`,
    ],
    ignorePaths: [],
  }),
])

/** @param {string} raw */
function compilePatterns(raw) {
  return raw.map(pattern => new RegExp(pattern, 'u'))
}

/** @param {string[]} globs @param {{ caseSensitive?: boolean }} [options] */
function compileIgnore(globs, options = {}) {
  return globs.length === 0 ? undefined : compileScope(globs, options)
}

/**
 * Build the effective rule set: defaults minus disabled, plus custom overrides.
 * @param {{ rules: { disabled: string[], custom: any[], ignorePaths: string[] }, scope: { caseSensitive: boolean } }} config
 * @returns {{ rules: any[], globalIgnore: any, versions: number }}
 */
export function resolveRuleset(config) {
  const disabled = new Set(config.rules.disabled)
  /** @type {Map<string, any>} */
  const effective = new Map()
  for (const rule of DEFAULT_RULES) {
    if (!disabled.has(rule.id)) effective.set(rule.id, rule)
  }
  for (const rule of config.rules.custom) {
    if (disabled.has(rule.id)) {
      effective.delete(rule.id)
      continue
    }
    effective.set(rule.id, rule)
  }
  const rules = [...effective.values()].map(rule => ({
    id: rule.id,
    title: rule.title ?? rule.id,
    severity: rule.severity,
    appliesTo: new Set(rule.appliesTo ?? []),
    patterns: compilePatterns(rule.patterns),
    ignorePaths: compileIgnore(rule.ignorePaths ?? [], { caseSensitive: config.scope.caseSensitive }),
  }))
  return {
    rules,
    globalIgnore: compileIgnore(config.rules.ignorePaths, { caseSensitive: config.scope.caseSensitive }),
    versions: RULESET_VERSION,
  }
}

/**
 * Read an inline `review-gate-ignore` marker.
 * @param {string} line
 * @returns {'all' | Set<string> | undefined}
 */
export function inlineIgnore(line) {
  const index = line.indexOf('review-gate-ignore')
  if (index < 0) return undefined
  const rest = line.slice(index + 'review-gate-ignore'.length)
  const ids = rest
    .replace(/^[^A-Za-z0-9._-]+/, '')
    .split(/[^A-Za-z0-9._-]+/)
    .filter(id => id !== '')
  return ids.length === 0 ? 'all' : new Set(ids)
}

/**
 * Read a file-header suppression marker from the first ten lines.
 * @param {string | undefined} content
 * @returns {'all' | Set<string> | undefined}
 */
export function headerIgnore(content) {
  if (typeof content !== 'string') return undefined
  const lines = content.replace(/\r\n?/g, '\n').split('\n', 10)
  for (const line of lines) {
    const ignore = inlineIgnore(line)
    if (ignore !== undefined) return ignore
  }
  return undefined
}

/** @param {'all' | Set<string> | undefined} ignore @param {string} ruleId */
function ignores(ignore, ruleId) {
  return ignore === 'all' || (ignore instanceof Set && ignore.has(ruleId))
}

/**
 * Evaluate rules over extracted deletions.
 * @param {{
 *   ruleset: ReturnType<typeof resolveRuleset>,
 *   toolName: string,
 *   absolutePath: string,
 *   cwd: string,
 *   deletions: { text: string, line: number }[],
 *   headerIgnore?: 'all' | Set<string> | undefined,
 *   ruleMs: number,
 * }}
 * @returns {{
 *   hits: { ruleId: string, title: string, severity: 'ask' | 'block', lines: number[], snippetHash: string }[],
 *   deleted: number,
 *   warnings: string[],
 *   skipped: boolean,
 * }}
 */
export function evaluateRules(options) {
  const { ruleset, toolName, absolutePath, cwd, deletions } = options
  const warnings = []
  if (ruleset.globalIgnore?.enabled && ruleset.globalIgnore.inScope(absolutePath, cwd)) {
    return { hits: [], deleted: deletions.length, warnings: ['path_ignored'], skipped: true }
  }
  const deleted = deletions.length
  if (deleted === 0) return { hits: [], deleted: 0, warnings, skipped: false }

  /** @type {{ ruleId: string, title: string, severity: 'ask' | 'block', lines: number[], snippetHash: string }[]} */
  const hits = []
  for (const rule of ruleset.rules) {
    if (!rule.appliesTo.has(toolName)) continue
    if (rule.ignorePaths?.enabled && rule.ignorePaths.inScope(absolutePath, cwd)) continue
    if (ignores(options.headerIgnore, rule.id)) continue
    /** @type {number[]} */
    const lines = []
    let snippetHash = ''
    let timedOut = false
    const started = performance.now()
    for (let index = 0; index < deletions.length; index += 1) {
      if ((index & 255) === 0 && performance.now() - started > options.ruleMs) {
        timedOut = true
        break
      }
      const deletion = deletions[index]
      if (isCommentOrBlank(deletion.text)) continue
      if (ignores(inlineIgnore(deletion.text), rule.id)) continue
      if (!rule.patterns.some(pattern => pattern.test(deletion.text))) continue
      if (snippetHash === '') snippetHash = sha256Prefix(deletion.text)
      if (!lines.includes(deletion.line)) lines.push(deletion.line)
    }
    if (timedOut) warnings.push(`rule_timeout:${rule.id}`)
    if (lines.length > 0) {
      hits.push({
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity,
        lines,
        snippetHash,
      })
    }
  }
  return { hits, deleted, warnings, skipped: false }
}

/**
 * Locate the 1-based first line of `needle` inside `content`, if unique enough.
 * Used to refine line numbers for edit/str_replace deletions.
 * @param {string} content
 * @param {string} needle
 * @returns {number}
 */
export function firstLineOf(content, needle) {
  if (needle === '') return 0
  const index = content.indexOf(needle)
  if (index < 0) return 0
  return content.slice(0, index).split('\n').length
}
