import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { DEFAULTS, resolveConfig } from '../src/config.js'

test('config: defaults are usable without any config', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.locale, 'auto')
  assert.equal(config.scope.enforce, true)
  assert.equal(config.scope.strict, false)
  assert.deepEqual(config.scope.default, [])
  assert.equal(config.scope.caseSensitive, false)
  assert.equal(config.rules.enabled, true)
  assert.deepEqual(config.protectedPaths, [...DEFAULTS.protectedPaths])
  assert.equal(config.onApprovalUnavailable, 'deny')
  assert.equal(config.onInternalError, 'allow')
  assert.equal(config.limits.preExecuteMs, 80)
  assert.equal(config.audit.enabled, true)
  assert.equal(config.review.maxUnits, 5)
  assert.ok(config.review.entryPatterns.includes('**/index.*'))
})

test('config: unknown keys fail loudly at every level', () => {
  assert.throws(() => resolveConfig({ nope: true }), /unknown key "nope"/)
  assert.throws(() => resolveConfig({ scope: { nope: true } }), /unknown key "scope.nope"/)
  assert.throws(() => resolveConfig({ rules: { nope: true } }), /unknown key "rules.nope"/)
  assert.throws(() => resolveConfig({ limits: { nope: 1 } }), /unknown key "limits.nope"/)
  assert.throws(() => resolveConfig({ audit: { nope: 1 } }), /unknown key "audit.nope"/)
})

test('config: invalid enums and types fail', () => {
  assert.throws(() => resolveConfig({ onApprovalUnavailable: 'maybe' }), /onApprovalUnavailable/)
  assert.throws(() => resolveConfig({ onInternalError: 'maybe' }), /onInternalError/)
  assert.throws(() => resolveConfig({ locale: 'fr' }), /locale/)
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => resolveConfig({ limits: { preExecuteMs: 1 } }), /limits.preExecuteMs/)
  assert.throws(() => resolveConfig({ limits: { readFileBytes: 1 } }), /limits.readFileBytes/)
})

test('config: scope defaults are validated as globs', () => {
  assert.throws(() => resolveConfig({ scope: { default: ['src/{a'] } }), /scope.default/)
  assert.throws(() => resolveConfig({ protectedPaths: ['!src/**'] }), /cannot contain negated/)
  assert.throws(() => resolveConfig({ protectedPaths: ['src/['] }), /protectedPaths/)
})

test('config: audit.dir must be absolute or empty', () => {
  assert.equal(resolveConfig({ audit: { dir: '' } }).audit.dir, '')
  const absolute = path.resolve('/tmp/audit')
  assert.equal(resolveConfig({ audit: { dir: absolute } }).audit.dir, absolute)
  assert.throws(() => resolveConfig({ audit: { dir: 'relative/audit' } }), /audit.dir/)
})

test('config: custom rules are validated and normalized', () => {
  const config = resolveConfig({
    rules: {
      disabled: ['RG-VALID-003'],
      custom: [{
        id: 'RG-CUSTOM-001',
        title: 'custom',
        severity: 'block',
        patterns: ['hasPermission\\(', 'requireRole\\('],
        appliesTo: ['edit'],
        ignorePaths: ['**/*.test.*'],
      }],
    },
  })
  assert.equal(config.rules.custom.length, 1)
  assert.equal(config.rules.custom[0].severity, 'block')
  assert.deepEqual(config.rules.custom[0].appliesTo, ['edit'])
  assert.throws(() => resolveConfig({ rules: { custom: [{ id: 'bad id', patterns: ['x'] }] } }), /custom\[0\]\.id/)
  assert.throws(() => resolveConfig({ rules: { custom: [{ id: 'RG-X', patterns: [] }] } }), /patterns must not be empty/)
  assert.throws(() => resolveConfig({ rules: { custom: [{ id: 'RG-X', patterns: ['('] }] } }), /not a valid regular expression/)
  assert.throws(() => resolveConfig({ rules: { custom: [{ id: 'RG-X', patterns: ['(a+)+'] }] } }), /catastrophically/)
})

test('config: review settings are validated', () => {
  const config = resolveConfig({ review: { maxUnits: 2, entryPatterns: ['**/main.*'] } })
  assert.equal(config.review.maxUnits, 2)
  assert.deepEqual(config.review.entryPatterns, ['**/main.*'])
  assert.throws(() => resolveConfig({ review: { maxUnits: 0 } }), /review.maxUnits/)
  assert.throws(() => resolveConfig({ review: { entryPatterns: ['src/{a'] } }), /review.entryPatterns/)
  assert.throws(() => resolveConfig({ review: { entryPatterns: ['src/{main,index}.*'] } }), /Client entry matcher/)
  assert.throws(() => resolveConfig({ review: { entryPatterns: ['src/[ab].*'] } }), /Client entry matcher/)
  assert.throws(() => resolveConfig({ review: { entryPatterns: ['!src/**'] } }), /Client entry matcher/)
  assert.throws(() => resolveConfig({ review: { unknown: true } }), /unknown key "review.unknown"/)
})

test('config: explicit empty arrays are preserved', () => {
  const config = resolveConfig({ scope: { default: [] }, rules: { ignorePaths: [] }, protectedPaths: [] })
  assert.deepEqual(config.scope.default, [])
  assert.deepEqual(config.rules.ignorePaths, [])
  assert.deepEqual(config.protectedPaths, [])
})
