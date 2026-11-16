import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import {
  DEFAULT_RULES,
  evaluateRules,
  firstLineOf,
  headerIgnore,
  inlineIgnore,
  resolveRuleset,
} from '../src/rules.js'

const cwd = path.resolve('/w')
const absolutePath = path.resolve(cwd, 'src/auth/login.ts')

/** @param {Partial<any>} [overrides] */
function config(overrides = {}) {
  return {
    scope: { caseSensitive: false },
    rules: {
      disabled: [],
      custom: [],
      ignorePaths: [],
      ...overrides.rules,
    },
  }
}

function ruleset(overrides) {
  return resolveRuleset(config(overrides))
}

function hitsFor(deletions, options = {}) {
  return evaluateRules({
    ruleset: options.ruleset ?? ruleset(options.config),
    toolName: options.toolName ?? 'edit',
    absolutePath,
    cwd,
    deletions,
    headerIgnore: options.headerIgnore,
    ruleMs: 5,
  })
}

test('rules: default rule set has the three documented IDs', () => {
  assert.deepEqual(DEFAULT_RULES.map(rule => rule.id), ['RG-AUTH-001', 'RG-GUARD-002', 'RG-VALID-003'])
})

test('rules: a deleted auth check hits RG-AUTH-001 with its line number', () => {
  const result = hitsFor([{ text: '  if (!user.hasPermission("admin")) {', line: 12 }])
  const hit = result.hits.find(entry => entry.ruleId === 'RG-AUTH-001')
  assert.ok(hit)
  assert.equal(hit.severity, 'ask')
  assert.deepEqual(hit.lines, [12])
})

test('rules: blank and comment deletions are skipped', () => {
  const result = hitsFor([
    { text: '', line: 1 },
    { text: '// hasPermission( is mentioned here', line: 2 },
    { text: ' * isAuthorized( in a doc comment', line: 3 },
  ])
  assert.equal(result.hits.length, 0)
})

test('rules: line-level ignore suppresses one rule or all rules', () => {
  const one = hitsFor([{ text: 'if (!x) { // review-gate-ignore RG-GUARD-002', line: 5 }])
  assert.equal(one.hits.some(hit => hit.ruleId === 'RG-GUARD-002'), false)
  const all = hitsFor([{ text: 'if (!x) { // review-gate-ignore', line: 5 }])
  assert.equal(all.hits.length, 0)
})

test('rules: inlineIgnore parses IDs and bare markers', () => {
  assert.equal(inlineIgnore('plain line'), undefined)
  assert.equal(inlineIgnore('// review-gate-ignore'), 'all')
  assert.deepEqual([...inlineIgnore('// review-gate-ignore RG-AUTH-001,RG-VALID-003')], ['RG-AUTH-001', 'RG-VALID-003'])
})

test('rules: header ignore suppresses matching rules for the whole file', () => {
  const ignore = headerIgnore('// review-gate-ignore RG-AUTH-001\nconst x = 1\n')
  assert.ok(ignore instanceof Set)
  const result = hitsFor([{ text: 'hasPermission(x)', line: 20 }], { headerIgnore: ignore })
  assert.equal(result.hits.length, 0)
  const other = hitsFor([{ text: 'if (!ok) {', line: 21 }], { headerIgnore: ignore })
  assert.equal(other.hits.length, 1)
})

test('rules: header ignore only reads the first ten lines', () => {
  const content = Array.from({ length: 12 }, (_, index) => index === 10 ? '// review-gate-ignore' : 'x').join('\n')
  assert.equal(headerIgnore(content), undefined)
})

test('rules: global ignorePaths skip test files', () => {
  const ignored = path.resolve(cwd, 'src/auth/login.test.ts')
  const result = evaluateRules({
    ruleset: ruleset({ rules: { ignorePaths: ['**/*.test.*'] } }),
    toolName: 'edit',
    absolutePath: ignored,
    cwd,
    deletions: [{ text: 'hasPermission(x)', line: 1 }],
    ruleMs: 5,
  })
  assert.equal(result.skipped, true)
  assert.equal(result.hits.length, 0)
})

test('rules: per-rule ignorePaths are honored', () => {
  const rule = {
    id: 'RG-LOCAL-001',
    title: 'local',
    severity: 'block',
    patterns: ['hasPermission'],
    ignorePaths: ['src/auth/**'],
    appliesTo: ['edit'],
  }
  const result = hitsFor(
    [{ text: 'hasPermission(x)', line: 1 }],
    { config: { rules: { ignorePaths: [], disabled: ['RG-AUTH-001', 'RG-GUARD-002', 'RG-VALID-003'], custom: [rule] } } },
  )
  assert.equal(result.hits.length, 0)
})

test('rules: custom block rule overrides a default ask rule', () => {
  const custom = {
    id: 'RG-AUTH-001',
    title: 'block auth deletions',
    severity: 'block',
    patterns: ['hasPermission'],
    appliesTo: ['edit'],
  }
  const result = hitsFor(
    [{ text: 'hasPermission(x)', line: 3 }],
    { config: { rules: { custom: [custom] } } },
  )
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].severity, 'block')
})

test('rules: disabled rules never fire', () => {
  const result = hitsFor(
    [{ text: 'hasPermission(x)', line: 3 }],
    { config: { rules: { disabled: ['RG-AUTH-001'] } } },
  )
  assert.equal(result.hits.length, 0)
})

test('rules: appliesTo is respected', () => {
  const result = hitsFor([{ text: 'hasPermission(x)', line: 3 }], { toolName: 'write' })
  assert.equal(result.hits.length, 1)
  const custom = {
    id: 'RG-EDIT-ONLY',
    severity: 'ask',
    patterns: ['hasPermission'],
    appliesTo: ['edit'],
  }
  const other = hitsFor(
    [{ text: 'hasPermission(x)', line: 3 }],
    {
      toolName: 'write',
      config: { rules: { disabled: ['RG-AUTH-001', 'RG-GUARD-002', 'RG-VALID-003'], custom: [custom] } },
    },
  )
  assert.equal(other.hits.length, 0)
})

test('rules: one rule reports all matching line numbers once', () => {
  const result = hitsFor([
    { text: 'hasPermission(a)', line: 2 },
    { text: 'hasPermission(b)', line: 4 },
  ])
  assert.equal(result.hits.length, 1)
  assert.deepEqual(result.hits[0].lines, [2, 4])
})

test('rules: firstLineOf reports a 1-based line', () => {
  assert.equal(firstLineOf('a\nb\nc', 'c'), 3)
  assert.equal(firstLineOf('a\nb\nc', 'missing'), 0)
  assert.equal(firstLineOf('a\nb\nc', ''), 0)
})
