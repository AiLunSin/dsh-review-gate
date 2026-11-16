/**
 * Deterministic decision-source extraction and conservative contradiction hints.
 *
 * Sources are ADR-style Markdown, project instruction files (CLAUDE.md /
 * AGENTS.md), and `@decision` comments in changed files. A hint is produced only
 * when a decision explicitly declares an `Applies to:` scope (or comes from the
 * changed file itself), the changed file is in scope, and a removed line
 * contains one of the decision's backticked identifiers. No LLM is involved.
 * @module dsh-review-gate/decisions
 */

import { globToRegExp } from './glob.js'

/** @param {string} value */
function compact(value) {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim()
}

/** @param {string} text */
function backticked(text) {
  const values = []
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const value = match[1].trim()
    if (value !== '') values.push(value)
  }
  return [...new Set(values)]
}

/** @param {string} text */
function keywordsOf(text) {
  return backticked(text).filter(value =>
    !value.includes('/')
    && !value.includes('*')
    && !value.endsWith('.md')
    && !value.endsWith('.json')
    && value.length >= 4
    && value.length <= 120)
}

/** @param {string} text */
function appliesToOf(text) {
  const values = []
  const explicit = /^\s*(?:[-*]\s+)?applies\s+to\s*:\s*(.+)$/im.exec(text)
  if (explicit !== null) {
    for (const part of explicit[1].split(/[,;]/)) {
      const scope = part.split(/\s+(?:—|–|-)\s+/u)[0].trim()
      if (scope !== '') values.push(scope)
    }
  }
  for (const token of backticked(text)) {
    if (token.includes('/') || token.includes('*')) values.push(token)
  }
  return [...new Set(values.map(value => value.trim()).filter(value =>
    value !== '' && !value.startsWith('/') && !value.includes('..')))]
}

/**
 * Parse Markdown decisions.
 * @param {string} text
 * @param {string} source
 * @returns {any[]}
 */
export function parseMarkdownDecisions(text, source) {
  const lines = text.split('\n')
  const decisions = []
  let index = 0
  while (index < lines.length) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[index])
    if (heading === null || !/ADR[- ]?\d+|Decision|决策/i.test(heading[2])) {
      index += 1
      continue
    }
    const level = heading[1].length
    let end = index + 1
    while (end < lines.length) {
      const next = /^(#{1,6})\s+/.exec(lines[end])
      if (next !== null && next[1].length <= level) break
      end += 1
    }
    const section = lines.slice(index, Math.min(end, index + 120)).join('\n')
    const headingText = compact(heading[2])
    const idMatch = /(ADR[- ]?\d+)/i.exec(headingText)
    const id = idMatch === null ? `DOC-${source}:${index + 1}` : idMatch[1].replace(/\s+/g, '-').toUpperCase()
    const appliesTo = appliesToOf(section)
    const keywords = keywordsOf(section)
    if (appliesTo.length > 0 && keywords.length > 0) {
      decisions.push({
        id,
        source,
        line: index + 1,
        text: compact(`${headingText} — ${section.split('\n').slice(1).join(' ')}`).slice(0, 1200),
        appliesTo,
        keywords,
        kind: 'adr',
      })
    }
    index = end
  }
  return decisions
}

/**
 * Parse instruction files into decisions. Only bullets/paragraphs with an
 * explicit applies-to path and a backticked identifier become annotatable.
 * @param {string} text
 * @param {string} source
 * @returns {any[]}
 */
export function parseInstructionDecisions(text, source) {
  const decisions = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!/^[-*]\s+/.test(line) || !/(must|never|always|禁止|不得|必须)/i.test(line)) continue
    const appliesTo = appliesToOf(line)
    const keywords = keywordsOf(line)
    if (appliesTo.length === 0 || keywords.length === 0) continue
    decisions.push({
      id: `DOC-${source}:${index + 1}`,
      source,
      line: index + 1,
      text: compact(line).slice(0, 800),
      appliesTo,
      keywords,
      kind: 'instruction',
    })
  }
  return decisions
}

/**
 * Parse `@decision` comments from source code.
 * @param {string} text
 * @param {string} source
 * @param {string} filePath
 * @returns {any[]}
 */
export function parseDecisionComments(text, source, filePath) {
  const decisions = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = /@decision\b\s*(?:([A-Za-z0-9._-]+))?\s*[:：]\s*(.+)$/.exec(lines[index])
    if (match === null) continue
    const id = match[1] ?? `COMMENT-${filePath}:${index + 1}`
    const comment = compact(match[2])
    const keywords = keywordsOf(comment)
    if (keywords.length === 0) continue
    decisions.push({
      id,
      source,
      line: index + 1,
      text: comment.slice(0, 800),
      appliesTo: [filePath],
      keywords,
      kind: 'comment',
    })
  }
  return decisions
}

/**
 * @param {string[]} appliesTo @param {string} filePath
 */
function applies(appliesTo, filePath) {
  for (const pattern of appliesTo) {
    try {
      if (globToRegExp(pattern).test(filePath)) return true
    } catch {
      // Fall through to a plain prefix match.
    }
    if (filePath === pattern || filePath.startsWith(`${pattern.replace(/\/$/, '')}/`)) return true
  }
  // A directory mention such as `src/auth` also covers its files.
  return false
}

/**
 * Whether a decision's `appliesTo` declarations cover one workspace-relative
 * file. Exported for the review route's diff shortlist.
 * @param {string[]} appliesTo
 * @param {string} filePath
 */
export function decisionApplies(appliesTo, filePath) {
  return applies(appliesTo, filePath)
}

/**
 * Collect decision hints for one turn.
 * @param {{
 *   decisions: any[],
 *   files: { path: string, index: number }[],
 *   removedLines: Map<string, string[]>,
 * }} options
 * @returns {{ file: string, index: number, decisionId: string, source: string, text: string, reason: string }[]}
 */
export function decisionHints(options) {
  const hints = []
  const seen = new Set()
  for (const decision of options.decisions) {
    for (const file of options.files) {
      if (!applies(decision.appliesTo, file.path)) continue
      const removed = options.removedLines.get(file.path)
      if (removed === undefined || removed.length === 0) continue
      const matched = removed.find(line => decision.keywords.some(keyword => line.includes(keyword)))
      if (matched === undefined) continue
      const key = `${decision.id}\u0000${file.path}`
      if (seen.has(key)) continue
      seen.add(key)
      hints.push({
        file: file.path,
        index: file.index,
        decisionId: decision.id,
        source: decision.source,
        text: decision.text,
        reason: 'removed-line-matches-decision',
      })
    }
  }
  return hints
}

/**
 * Extract removed lines from one workspace diff.
 * @param {any} diff
 * @returns {string[]}
 */
export function removedLinesFromDiff(diff) {
  if (diff === undefined || diff === null || diff.kind !== 'text' || !Array.isArray(diff.hunks)) return []
  const removed = []
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines ?? []) {
      if (typeof line !== 'string' || !line.startsWith('-') || line.startsWith('---')) continue
      removed.push(line.slice(1))
      if (removed.length >= 2000) return removed
    }
  }
  return removed
}
