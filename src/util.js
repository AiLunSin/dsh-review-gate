/**
 * Small dependency-free helpers shared by the Host half.
 * @module dsh-review-gate/util
 */

import { createHash } from 'node:crypto'

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Stable short hash used to correlate a sensitive line without storing it.
 * @param {string} text
 * @param {number} [length]
 * @returns {string}
 */
export function sha256Prefix(text, length = 8) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, length)
}

/**
 * Split text into lines with CRLF normalized. A single trailing newline does not
 * create a phantom empty line, so "delete the final newline" style rewrites do
 * not look like a content deletion.
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Multiset line subtraction: lines present in `after` are retained, the rest are
 * reported as deleted with their 1-based line number in `before`.
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {{ text: string, line: number }[]}
 */
export function removedLines(beforeText, afterText) {
  const before = splitLines(beforeText)
  const after = splitLines(afterText)
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const line of after) counts.set(line, (counts.get(line) ?? 0) + 1)
  /** @type {{ text: string, line: number }[]} */
  const removed = []
  for (let index = 0; index < before.length; index += 1) {
    const line = before[index]
    const remaining = counts.get(line) ?? 0
    if (remaining > 0) {
      counts.set(line, remaining - 1)
      continue
    }
    removed.push({ text: line, line: index + 1 })
  }
  return removed
}

/**
 * Convert every backslash to a forward slash and collapse duplicate separators.
 * @param {string} value
 * @returns {string}
 */
export function toPosix(value) {
  return String(value).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

/**
 * Normalize a path for lexical matching without touching the filesystem.
 * @param {string} value
 * @returns {string}
 */
export function normalizePath(value) {
  let path = toPosix(value)
  if (path.startsWith('./')) path = path.slice(2)
  return path
}

/**
 * Whether a string starts with a POSIX or Windows absolute path marker.
 * @param {string} value
 * @returns {boolean}
 */
export function isAbsolutePath(value) {
  const path = String(value)
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * Escape a literal fragment for use inside a RegExp.
 * @param {string} value
 * @returns {string}
 */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Heuristic comment/blank detection used before matching sensitive rules.
 * Deliberately conservative: a line is skipped only when it is blank or starts
 * with a comment marker that is unambiguous in the common languages DSH edits.
 * @param {string} line
 * @returns {boolean}
 */
export function isCommentOrBlank(line) {
  const trimmed = String(line).trim()
  if (trimmed === '') return true
  if (trimmed.startsWith('//')) return true
  if (trimmed.startsWith('/*') || trimmed.startsWith('*/')) return true
  if (trimmed.startsWith('*') && !trimmed.startsWith('*/')) return true
  if (trimmed.startsWith('<!--')) return true
  if (/^#[ \t!]/.test(trimmed) || trimmed === '#') return true
  if (/^--[ \t]/.test(trimmed)) return true
  return false
}

/**
 * Group items by a key while preserving first-seen order.
 * @template T, K
 * @param {T[]} items
 * @param {(item: T) => K} keyOf
 * @returns {Map<K, T[]>}
 */
export function groupBy(items, keyOf) {
  /** @type {Map<K, T[]>} */
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [item])
    else group.push(item)
  }
  return groups
}

/**
 * A bounded dedupe helper.
 * @param {string[]} values
 * @returns {string[]}
 */
export function unique(values) {
  return [...new Set(values)]
}
