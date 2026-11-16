/**
 * Host-side review-unit construction for P2: import-graph components when
 * available, directory grouping otherwise. Pure and deterministic; no I/O.
 * @module dsh-review-gate/review-units
 */

import path from 'node:path'
import { globToRegExp } from './glob.js'

/** @param {string} value */
function toPosix(value) {
  return value.replace(/\\/g, '/')
}

/** @param {string} value */
function dirname(value) {
  const index = value.lastIndexOf('/')
  return index <= 0 ? '' : value.slice(0, index)
}

/** @param {string} value */
function basename(value) {
  const index = value.lastIndexOf('/')
  return index < 0 ? value : value.slice(index + 1)
}

/** @param {string} value */
function normalize(value) {
  const normalized = path.posix.normalize(toPosix(value))
  return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

/** @param {string} group */
function groupKey(filePath, depthForTop = 2) {
  const directory = dirname(filePath)
  const segments = directory === '' ? [] : directory.split('/')
  if (segments.length === 0) return '.'
  const depth = ['packages', 'apps', 'libs'].includes(segments[0]) ? 3 : depthForTop
  return segments.slice(0, depth).join('/')
}

/**
 * @param {{ path: string, display?: string, added: number, deleted: number, binary?: true, oversized?: true, index?: number }[]} files
 * @param {{ maxUnits?: number, entryPatterns?: string[], edges?: Map<string, Set<string>> }} [options]
 * @returns {any[]}
 */
export function buildReviewUnits(files, options = {}) {
  const maxUnits = Math.max(1, Math.min(20, Number(options.maxUnits) || 5))
  const patterns = options.entryPatterns ?? []
  const entryMatchers = patterns.map(pattern => globToRegExp(pattern))
  const isEntry = file => entryMatchers.some(regex => regex.test(normalize(file.path)))
  const ordered = [...files].sort((left, right) => normalize(left.path).localeCompare(normalize(right.path)))
  const edges = options.edges ?? new Map()

  /** @type {Map<string, { key: string, files: any[], entryNames: string[], imports: number }>} */
  const units = new Map()

  /** Add one file under a key. */
  const assign = (key, file, entryNames = [], imports = 0) => {
    let unit = units.get(key)
    if (unit === undefined) {
      unit = { key, files: [], entryNames: [], imports: 0 }
      units.set(key, unit)
    }
    if (!unit.files.includes(file)) unit.files.push(file)
    for (const name of entryNames) if (!unit.entryNames.includes(name)) unit.entryNames.push(name)
    unit.imports += imports
  }

  const visited = new Set()
  for (const entry of ordered.filter(file => isEntry(file))) {
    if (visited.has(entry.path)) continue
    const queue = [normalize(entry.path)]
    const component = []
    while (queue.length > 0) {
      const current = queue.pop()
      if (visited.has(current)) continue
      visited.add(current)
      component.push(current)
      for (const next of edges.get(current) ?? []) {
        if (!visited.has(next)) queue.push(next)
      }
    }
    const entryNames = component.filter(file => isEntry({ path: file })).map(basename)
    const unitKey = `entry:${normalize(entry.path)}`
    let imports = 0
    for (const filePath of component) imports += edges.get(filePath)?.size ?? 0
    for (const filePath of component) {
      const file = ordered.find(candidate => normalize(candidate.path) === filePath)
      if (file !== undefined) assign(unitKey, file, entryNames, 0)
    }
    const unit = units.get(unitKey)
    if (unit !== undefined) unit.imports = imports
  }

  for (const file of ordered) {
    if (visited.has(normalize(file.path))) continue
    assign(groupKey(normalize(file.path)), file)
  }

  let result = [...units.values()].map(unit => {
    const added = unit.files.reduce((sum, file) => sum + file.added, 0)
    const deleted = unit.files.reduce((sum, file) => sum + file.deleted, 0)
    const entry = unit.entryNames.length > 0
    const reasons = []
    if (entry) reasons.push(`entry:${unit.entryNames.join(', ')}`)
    if (unit.imports > 0) reasons.push(`imports:${unit.imports}`)
    if (added + deleted > 0) reasons.push(`size:${added}:${deleted}`)
    if (unit.files.some(file => file.binary === true || file.oversized === true)) reasons.push('binary')
    return {
      key: unit.key,
      title: unit.key === '__merged__' ? '__merged__' : unit.key,
      files: unit.files,
      added,
      deleted,
      entry,
      reasons,
      merged: 0,
    }
  })

  result.sort((left, right) =>
    Number(right.entry) - Number(left.entry)
    || (right.added + right.deleted) - (left.added + left.deleted)
    || left.key.localeCompare(right.key))
  if (result.length > maxUnits) {
    const kept = result.slice(0, maxUnits - 1)
    const rest = result.slice(maxUnits - 1)
    const mergedFiles = rest.flatMap(unit => unit.files)
    kept.push({
      key: '__merged__',
      title: '__merged__',
      files: mergedFiles,
      added: rest.reduce((sum, unit) => sum + unit.added, 0),
      deleted: rest.reduce((sum, unit) => sum + unit.deleted, 0),
      entry: false,
      reasons: [`merged:${mergedFiles.length}`],
      merged: mergedFiles.length,
    })
    result = kept
  }
  return result
}

/** Extensions tried for relative JS/TS imports, in order. */
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

/**
 * Parse relative import specifiers from one source file. Only relative
 * specifiers can create an edge among changed files; package imports are not
 * followed.
 * @param {string} source
 * @param {string} filePath
 * @returns {string[]}
 */
export function importSpecifiers(source, filePath) {
  const ext = path.posix.extname(filePath).toLowerCase()
  const found = []
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const patterns = [
      /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
      /import\s*['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        if (match[1].startsWith('.')) found.push(match[1])
      }
    }
  } else if (ext === '.py') {
    for (const line of source.split(/\r?\n/)) {
      const from = /^\s*from\s+(\.[.\w]*)\s+import\b/.exec(line)
      if (from !== null && from[1].startsWith('.')) found.push(from[1])
      const plain = /^\s*import\s+(\.[.\w]*)\b/.exec(line)
      if (plain !== null && plain[1].startsWith('.')) found.push(plain[1])
    }
  }
  return [...new Set(found)]
}

/**
 * Resolve a relative specifier to a changed file path, if one exists.
 * @param {string} fromPath
 * @param {string} specifier
 * @param {Set<string>} changed
 * @returns {string | undefined}
 */
export function resolveRelativeImport(fromPath, specifier, changed) {
  const fromExt = path.posix.extname(fromPath).toLowerCase()
  if (fromExt === '.py' && specifier.startsWith('.')) {
    let dots = 0
    while (specifier[dots] === '.') dots += 1
    const rest = specifier.slice(dots).replace(/\./g, '/')
    const base = path.posix.join(dirname(fromPath), ...Array(Math.max(0, dots - 1)).fill('..'), rest)
    const candidates = [
      normalize(`${base}.py`),
      normalize(`${base}/__init__.py`),
    ]
    return candidates.find(candidate => changed.has(candidate))
  }
  if (!specifier.startsWith('.')) return undefined
  const base = normalize(path.posix.join(dirname(fromPath), specifier))
  const candidates = [base]
  if (!path.posix.extname(base)) {
    for (const extension of JS_EXTENSIONS) candidates.push(`${base}${extension}`)
    for (const extension of JS_EXTENSIONS) candidates.push(`${base}/index${extension}`)
    candidates.push(`${base}/__init__.py`)
  } else {
    // TypeScript/Node ESM often imports `.js` while the source is `.ts`.
    const extension = path.posix.extname(base)
    const stem = base.slice(0, -extension.length)
    for (const candidate of [`${stem}.ts`, `${stem}.tsx`]) candidates.push(candidate)
  }
  return candidates.find(candidate => changed.has(candidate))
}

/**
 * Build undirected adjacency among changed files from their current content.
 * @param {{ path: string, content?: string }[]} files
 * @returns {Map<string, Set<string>>}
 */
export function buildImportEdges(files) {
  const changed = new Set(files.map(file => normalize(file.path)))
  const edges = new Map()
  for (const file of files) {
    if (typeof file.content !== 'string') continue
    const filePath = normalize(file.path)
    for (const specifier of importSpecifiers(file.content, filePath)) {
      const target = resolveRelativeImport(filePath, specifier, changed)
      if (target === undefined || target === filePath) continue
      if (!edges.has(filePath)) edges.set(filePath, new Set())
      if (!edges.has(target)) edges.set(target, new Set())
      edges.get(filePath).add(target)
      edges.get(target).add(filePath)
    }
  }
  return edges
}
