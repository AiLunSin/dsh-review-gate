/**
 * Configuration defaults and fail-loud normalization.
 *
 * The schema is intentionally hand-written (no runtime dependency): an invalid
 * value throws during plugin activation, so a typo never becomes a silent
 * fallback. Unknown keys are rejected for the same reason.
 * @module dsh-review-gate/config
 */

import { compileProtected, compileScope } from './glob.js'
import { isPlainObject, isAbsolutePath } from './util.js'

export const LOCALES = Object.freeze(['auto', 'zh', 'en'])
export const APPROVAL_FALLBACKS = Object.freeze(['deny', 'allow'])
export const INTERNAL_FALLBACKS = Object.freeze(['allow', 'deny'])
export const SEVERITIES = Object.freeze(['ask', 'block'])

export const DEFAULT_IGNORE_PATHS = Object.freeze([
  '**/*.test.*',
  '**/*.spec.*',
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/generated/**',
])

export const DEFAULTS = Object.freeze({
  enabled: true,
  locale: 'auto',
  scope: Object.freeze({
    enforce: true,
    strict: false,
    default: Object.freeze([]),
    caseSensitive: false,
  }),
  rules: Object.freeze({
    enabled: true,
    disabled: Object.freeze([]),
    custom: Object.freeze([]),
    ignorePaths: DEFAULT_IGNORE_PATHS,
  }),
  protectedPaths: Object.freeze(['.git/**', '**/.git/**', '**/*.pem', '**/*.key']),
  onApprovalUnavailable: 'deny',
  onInternalError: 'allow',
  limits: Object.freeze({
    preExecuteMs: 80,
    readFileBytes: 262_144,
    readFileMs: 20,
    ruleMs: 5,
    auditQueue: 1000,
  }),
  audit: Object.freeze({
    enabled: true,
    dir: '',
    maxFileBytes: 8_388_608,
  }),
  review: Object.freeze({
    maxUnits: 5,
    entryPatterns: Object.freeze([
      '**/index.*',
      '**/main.*',
      '**/app.*',
      '**/server.*',
      '**/cli.*',
      '**/__init__.py',
      '**/mod.*',
    ]),
  }),
})

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(`dsh-review-gate/config: ${message}`)
}

/** @param {unknown} value @param {string} field @returns {Record<string, unknown>} */
function section(value, field) {
  if (value === undefined) return {}
  if (!isPlainObject(value)) fail(`${field} must be an object`)
  return value
}

/** @param {Record<string, unknown>} input @param {string[]} known @param {string} prefix */
function rejectUnknown(input, known, prefix) {
  const allowed = new Set(known)
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(`unknown key "${prefix}${key}"`)
  }
}

/** @param {unknown} value @param {string} field @param {boolean} fallback @returns {boolean} */
function bool(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`)
  return value
}

/** @param {unknown} value @param {string} field @param {string[]} allowed @param {string} fallback */
function oneOf(value, field, allowed, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(`${field} must be one of ${allowed.map(item => `"${item}"`).join(', ')}`)
  }
  return value
}

/** @param {unknown} value @param {string} field @param {number} min @param {number} max @param {number} fallback */
function integer(value, field, min, max, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(`${field} must be an integer`)
  if (value < min || value > max) fail(`${field} must be in ${min}..${max}`)
  return value
}

/** @param {unknown} value @param {string} field @returns {string[]} */
function stringArray(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    fail(`${field} must be an array of strings`)
  }
  return [...new Set(value.map(item => item.trim()).filter(item => item !== ''))]
}

/** @param {unknown} value @param {string} field */
function globArray(value, field) {
  const globs = stringArray(value, field)
  try {
    compileScope(globs, { caseSensitive: false })
  } catch (error) {
    fail(`${field}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return globs
}

/** @param {unknown} value @param {string} field @returns {Record<string, unknown>[]} */
function customRules(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${field} must be an array`)
  const known = ['id', 'title', 'severity', 'appliesTo', 'patterns', 'ignorePaths']
  const seen = new Set()
  return value.map((entry, index) => {
    const prefix = `${field}[${index}]`
    if (!isPlainObject(entry)) fail(`${prefix} must be an object`)
    rejectUnknown(entry, known, `${prefix}.`)
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(entry.id)) {
      fail(`${prefix}.id must match ${String.raw`/^[A-Za-z0-9._-]{1,64}$/`}`)
    }
    if (seen.has(entry.id)) fail(`${prefix}.id "${entry.id}" is duplicated`)
    seen.add(entry.id)
    const severity = oneOf(entry.severity, `${prefix}.severity`, SEVERITIES, 'ask')
    const patterns = stringArray(entry.patterns, `${prefix}.patterns`)
    if (patterns.length === 0) fail(`${prefix}.patterns must not be empty`)
    for (const pattern of patterns) {
      if (pattern.length > 200) fail(`${prefix}.patterns entries must be at most 200 characters`)
      if (/\([^)]*[+*][^)]*\)[+*?]/.test(pattern)) {
        fail(`${prefix}.patterns contains a nested quantifier that can backtrack catastrophically: ${pattern}`)
      }
      try {
        new RegExp(pattern, 'u')
      } catch (error) {
        fail(`${prefix}.patterns entry ${JSON.stringify(pattern)} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const ignorePaths = globArray(entry.ignorePaths, `${prefix}.ignorePaths`)
    const appliesTo = stringArray(entry.appliesTo, `${prefix}.appliesTo`)
    return {
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : entry.id,
      severity,
      patterns,
      ignorePaths,
      appliesTo: appliesTo.length > 0
        ? appliesTo
        : ['write', 'edit', 'apply_patch', 'str_replace_editor'],
    }
  })
}

/**
 * Normalize and validate raw plugin config.
 * @param {unknown} raw
 */
export function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) fail('config must be an object')
  const input = raw ?? {}
  rejectUnknown(input, ['enabled', 'locale', 'scope', 'rules', 'protectedPaths', 'onApprovalUnavailable', 'onInternalError', 'limits', 'audit', 'review'], '')

  const scopeInput = section(input.scope, 'scope')
  rejectUnknown(scopeInput, ['enforce', 'strict', 'default', 'caseSensitive'], 'scope.')
  const strict = bool(scopeInput.strict, 'scope.strict', DEFAULTS.scope.strict)
  const scope = {
    enforce: bool(scopeInput.enforce, 'scope.enforce', DEFAULTS.scope.enforce),
    strict,
    default: globArray(scopeInput.default, 'scope.default'),
    caseSensitive: bool(scopeInput.caseSensitive, 'scope.caseSensitive', DEFAULTS.scope.caseSensitive),
  }

  const rulesInput = section(input.rules, 'rules')
  rejectUnknown(rulesInput, ['enabled', 'disabled', 'custom', 'ignorePaths'], 'rules.')
  const rules = {
    enabled: bool(rulesInput.enabled, 'rules.enabled', DEFAULTS.rules.enabled),
    disabled: stringArray(rulesInput.disabled, 'rules.disabled'),
    custom: customRules(rulesInput.custom, 'rules.custom'),
    ignorePaths: globArray(
      rulesInput.ignorePaths === undefined ? DEFAULT_IGNORE_PATHS : rulesInput.ignorePaths,
      'rules.ignorePaths',
    ),
  }

  const protectedPaths = globArray(
    input.protectedPaths === undefined ? DEFAULTS.protectedPaths : input.protectedPaths,
    'protectedPaths',
  )
  if (protectedPaths.some(pattern => pattern.startsWith('!'))) {
    fail('protectedPaths cannot contain negated patterns')
  }
  try {
    compileProtected(protectedPaths)
  } catch (error) {
    fail(`protectedPaths: ${error instanceof Error ? error.message : String(error)}`)
  }

  const limitsInput = section(input.limits, 'limits')
  rejectUnknown(limitsInput, ['preExecuteMs', 'readFileBytes', 'readFileMs', 'ruleMs', 'auditQueue'], 'limits.')
  const limits = {
    preExecuteMs: integer(limitsInput.preExecuteMs, 'limits.preExecuteMs', 10, 5000, DEFAULTS.limits.preExecuteMs),
    readFileBytes: integer(limitsInput.readFileBytes, 'limits.readFileBytes', 1024, 4_194_304, DEFAULTS.limits.readFileBytes),
    readFileMs: integer(limitsInput.readFileMs, 'limits.readFileMs', 1, 2000, DEFAULTS.limits.readFileMs),
    ruleMs: integer(limitsInput.ruleMs, 'limits.ruleMs', 1, 200, DEFAULTS.limits.ruleMs),
    auditQueue: integer(limitsInput.auditQueue, 'limits.auditQueue', 10, 100_000, DEFAULTS.limits.auditQueue),
  }

  const auditInput = section(input.audit, 'audit')
  rejectUnknown(auditInput, ['enabled', 'dir', 'maxFileBytes'], 'audit.')
  const dir = auditInput.dir === undefined ? '' : auditInput.dir
  if (typeof dir !== 'string') fail('audit.dir must be a string')
  if (dir !== '' && !isAbsolutePath(dir)) fail('audit.dir must be empty (default) or an absolute path')

  const audit = {
    enabled: bool(auditInput.enabled, 'audit.enabled', DEFAULTS.audit.enabled),
    dir: dir.trim(),
    maxFileBytes: integer(auditInput.maxFileBytes, 'audit.maxFileBytes', 65_536, 104_857_600, DEFAULTS.audit.maxFileBytes),
  }

  const reviewInput = section(input.review, 'review')
  rejectUnknown(reviewInput, ['maxUnits', 'entryPatterns'], 'review.')
  const entryPatterns = globArray(
    reviewInput.entryPatterns === undefined ? DEFAULTS.review.entryPatterns : reviewInput.entryPatterns,
    'review.entryPatterns',
  )
  for (const pattern of entryPatterns) {
    if (/[!{}[\]]/.test(pattern)) {
      fail(`review.entryPatterns entry ${JSON.stringify(pattern)} uses a construct the Client entry matcher does not support; use only *, ** and ?`)
    }
  }
  const review = {
    maxUnits: integer(reviewInput.maxUnits, 'review.maxUnits', 1, 20, DEFAULTS.review.maxUnits),
    entryPatterns,
  }

  return {
    enabled: bool(input.enabled, 'enabled', DEFAULTS.enabled),
    locale: oneOf(input.locale, 'locale', LOCALES, DEFAULTS.locale),
    scope,
    rules,
    protectedPaths,
    onApprovalUnavailable: oneOf(
      input.onApprovalUnavailable,
      'onApprovalUnavailable',
      APPROVAL_FALLBACKS,
      DEFAULTS.onApprovalUnavailable,
    ),
    onInternalError: oneOf(
      input.onInternalError,
      'onInternalError',
      INTERNAL_FALLBACKS,
      DEFAULTS.onInternalError,
    ),
    limits,
    audit,
    review,
  }
}
