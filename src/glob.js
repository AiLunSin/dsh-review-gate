/**
 * Zero-dependency glob compiler for the documented scope subset.
 *
 * Supported: `*` (one path segment), `**` (any depth), `?` (one character),
 * `{a,b}` (finite alternatives), `[abc]` (character class), and a leading `!`
 * on a scope token to exclude a path. Patterns are anchored as a whole.
 *
 * @module dsh-review-gate/glob
 */

import path from 'node:path'
import { isAbsolutePath, normalizePath, toPosix } from './util.js'

/** A malformed glob token. */
export class GlobError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(`[review-gate] invalid glob: ${message}`)
    this.name = 'ReviewGateGlobError'
  }
}

/**
 * Expand one glob fragment into a regular expression source string.
 * @param {string} pattern
 * @returns {string}
 */
function fragmentSource(pattern) {
  let source = ''
  let index = 0
  const length = pattern.length
  while (index < length) {
    const char = pattern[index]
    if (char === '*') {
      const doubled = pattern[index + 1] === '*'
      if (doubled) {
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]+/)*'
          index += 3
          continue
        }
        source += '.*'
        index += 2
        continue
      }
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    if (char === '[') {
      const close = pattern.indexOf(']', index + 2)
      if (close < 0) throw new GlobError(`unterminated character class in "${pattern}"`)
      let content = pattern.slice(index + 1, close)
      if (content.includes('/')) throw new GlobError(`"/" cannot appear in a character class: "${pattern}"`)
      content = content.replace(/\\/g, '\\\\')
      if (content.startsWith('!')) content = `^${content.slice(1)}`
      source += `[${content}]`
      index = close + 1
      continue
    }
    if (char === '{') {
      const close = pattern.indexOf('}', index + 1)
      if (close < 0) throw new GlobError(`unterminated brace group in "${pattern}"`)
      const body = pattern.slice(index + 1, close)
      if (body.includes('{')) throw new GlobError(`nested brace groups are not supported: "${pattern}"`)
      const alternatives = splitAlternatives(body)
      if (alternatives.length === 1) {
        source += `(?:${escapeRegexLiteral(body)})`
      } else {
        if (alternatives.length > 32) throw new GlobError(`too many brace alternatives in "${pattern}"`)
        source += `(?:${alternatives.map(fragmentSource).join('|')})`
      }
      index = close + 1
      continue
    }
    if (char === '}') throw new GlobError(`unmatched "}" in "${pattern}"`)
    if ('\\^$.|+()'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
    index += 1
  }
  return source
}

/** @param {string} body @returns {string[]} */
function splitAlternatives(body) {
  /** @type {string[]} */
  const parts = []
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === ',') {
      parts.push(body.slice(start, index))
      start = index + 1
    }
  }
  parts.push(body.slice(start))
  if (parts.some(part => part === '')) throw new GlobError('empty brace alternative')
  return parts
}

/** @param {string} value @returns {string} */
function escapeRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile a non-negated glob into an anchored RegExp.
 * @param {string} rawPattern
 * @param {{ caseSensitive?: boolean }} [options]
 * @returns {RegExp}
 */
export function globToRegExp(rawPattern, options = {}) {
  const pattern = normalizePath(String(rawPattern).trim())
  if (pattern === '') throw new GlobError('empty pattern')
  if (pattern.includes('\0')) throw new GlobError('NUL is not allowed')
  const source = fragmentSource(pattern)
  return new RegExp(`^${source}$`, options.caseSensitive === false ? 'iu' : 'u')
}

/**
 * Parse a scope token: an optional leading `!` marks an exclusion.
 * @param {string} rawToken
 * @returns {{ pattern: string, negated: boolean }}
 */
export function parseScopeToken(rawToken) {
  const token = String(rawToken).trim()
  if (token === '') throw new GlobError('empty token')
  let pattern = token
  let negated = false
  if (token.startsWith('!')) {
    negated = true
    pattern = token.slice(1)
    if (pattern.trim() === '') throw new GlobError(`exclusion "${token}" has no pattern`)
  }
  globToRegExp(pattern)
  return { pattern, negated }
}

/**
 * Convert an absolute path to a cwd-relative POSIX path. A path outside the cwd
 * keeps leading `..` segments, so relative patterns cannot accidentally match it.
 * @param {string} absolutePath
 * @param {string} cwd
 * @returns {string}
 */
export function relativePath(absolutePath, cwd) {
  const relative = path.relative(cwd, absolutePath)
  if (relative === '') return '.'
  return toPosix(relative)
}

/**
 * Compile a declared scope into a matcher over absolute paths.
 * @param {string[]} globs
 * @param {{ caseSensitive?: boolean }} [options]
 */
export function compileScope(globs, options = {}) {
  const caseSensitive = options.caseSensitive === true
  /** @type {{ regex: RegExp, negated: boolean, absolute: boolean, pattern: string }[]} */
  const compiled = []
  for (const token of globs) {
    const { pattern, negated } = parseScopeToken(token)
    compiled.push({
      pattern,
      negated,
      absolute: isAbsolutePath(pattern),
      regex: globToRegExp(pattern, { caseSensitive }),
    })
  }
  const hasPositive = compiled.some(item => !item.negated)
  const enabled = compiled.length > 0

  /**
   * @param {string} absolutePath
   * @param {string} cwd
   * @returns {boolean}
   */
  function inScope(absolutePath, cwd) {
    if (!enabled) return true
    const absolute = normalizePath(absolutePath)
    const relative = relativePath(absolutePath, cwd)
    const outside = relative === '..'
      || relative.startsWith('../')
      || path.isAbsolute(relative)
    const matches = (item) => item.absolute
      ? item.regex.test(absolute)
      : !outside && item.regex.test(relative)
    for (const item of compiled) {
      if (item.negated && matches(item)) return false
    }
    if (hasPositive) {
      for (const item of compiled) {
        if (!item.negated && matches(item)) return true
      }
      return false
    }
    // Exclusion-only scope means "inside the workspace except these paths".
    // It must not silently become disk-wide just because the candidate is outside.
    return !outside
  }

  return {
    globs: [...globs],
    enabled,
    hasPositive,
    inScope,
  }
}

/**
 * Compile protected-path patterns. Exclusions are not meaningful here and are rejected.
 * @param {string[]} patterns
 * @param {{ caseSensitive?: boolean }} [options]
 */
export function compileProtected(patterns, options = {}) {
  const caseSensitive = options.caseSensitive === true
  const compiled = []
  for (const raw of patterns) {
    const pattern = String(raw).trim()
    if (pattern.startsWith('!')) throw new GlobError(`protected path "${raw}" cannot be negated`)
    compiled.push({
      pattern,
      absolute: isAbsolutePath(pattern),
      regex: globToRegExp(pattern, { caseSensitive }),
    })
  }
  /**
   * @param {string} absolutePath
   * @param {string} cwd
   * @returns {boolean}
   */
  function matches(absolutePath, cwd) {
    const absolute = normalizePath(absolutePath)
    const relative = relativePath(absolutePath, cwd)
    return compiled.some(item => item.regex.test(item.absolute ? absolute : relative))
  }
  return { patterns: [...patterns], matches }
}

/**
 * Split a command's raw input into scope tokens. Whitespace separates tokens;
 * quoted patterns are not supported (documented limitation).
 * @param {string} rawInput
 * @returns {string[]}
 */
export function splitScopeTokens(rawInput) {
  return String(rawInput).trim().split(/\s+/).filter(token => token !== '')
}
