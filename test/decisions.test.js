import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decisionApplies,
  decisionHints,
  parseDecisionComments,
  parseInstructionDecisions,
  parseMarkdownDecisions,
  removedLinesFromDiff,
} from '../src/decisions.js'

const adr = `# ADR-001: auth checks

Status: Accepted

Decision: every auth path must call \`hasPermission(\`.

Applies to: src/auth/**

The \`authorize(\` helper is also required.
`

test('decisions: ADR heading, scope, and backticked identifiers are extracted', () => {
  const decisions = parseMarkdownDecisions(adr, 'docs/adr/001.md')
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].id, 'ADR-001')
  assert.deepEqual(decisions[0].appliesTo, ['src/auth/**'])
  assert.ok(decisions[0].keywords.includes('hasPermission('))
  assert.ok(decisions[0].text.includes('every auth path'))
})

test('decisions: an ADR without an explicit scope is not annotatable', () => {
  const decisions = parseMarkdownDecisions('# ADR-002: style\n\nUse `prettier`.\n', 'docs/adr/002.md')
  assert.deepEqual(decisions, [])
})

test('decisions: instruction files require a scope and identifier', () => {
  const text = '- Applies to: src/auth/** — auth must call `hasPermission(`\n- Use `prettier` everywhere\n'
  const decisions = parseInstructionDecisions(text, 'CLAUDE.md')
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'instruction')
  assert.deepEqual(decisions[0].appliesTo, ['src/auth/**'])
})

test('decisions: @decision comments are file-scoped', () => {
  const source = '// @decision ADR-001: auth must call `hasPermission(`\nexport const x = 1\n'
  const decisions = parseDecisionComments(source, 'src/auth/login.ts', 'src/auth/login.ts')
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].id, 'ADR-001')
  assert.deepEqual(decisions[0].appliesTo, ['src/auth/login.ts'])
})

test('decisions: appliesTo supports globs and directory prefixes', () => {
  assert.equal(decisionApplies(['src/auth/**'], 'src/auth/login.ts'), true)
  assert.equal(decisionApplies(['src/auth'], 'src/auth/login.ts'), true)
  assert.equal(decisionApplies(['src/auth/**'], 'src/utils/a.ts'), false)
})

test('decisions: hints only fire on removed lines containing a decision identifier', () => {
  const decisions = parseMarkdownDecisions(adr, 'docs/adr/001.md')
  const files = [{ path: 'src/auth/login.ts', index: 1 }]
  const removedLines = new Map([
    ['src/auth/login.ts', ['  if (!user.hasPermission("admin")) {']],
  ])
  const hints = decisionHints({ decisions, files, removedLines })
  assert.equal(hints.length, 1)
  assert.equal(hints[0].decisionId, 'ADR-001')
  assert.equal(hints[0].index, 1)
  assert.match(hints[0].text, /every auth path/)
  const unrelated = decisionHints({
    decisions,
    files,
    removedLines: new Map([['src/auth/login.ts', ['const label = "hello"']]]),
  })
  assert.deepEqual(unrelated, [])
})

test('decisions: removedLinesFromDiff reads only removed text lines', () => {
  const diff = {
    kind: 'text',
    hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 2, lines: [' keep', '-old line', '+new line', '--- header'] }],
  }
  assert.deepEqual(removedLinesFromDiff(diff), ['old line'])
  assert.deepEqual(removedLinesFromDiff({ kind: 'binary' }), [])
})
