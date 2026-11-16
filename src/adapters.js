/**
 * Tool adapters: map each file-mutating tool's arguments to concrete targets and
 * the lines that will be removed. Unknown tools are left alone here; the
 * `fs/*-intent` safety net covers their resolved targets instead.
 * @module dsh-review-gate/adapters
 */

import path from 'node:path'
import { splitLines, removedLines } from './util.js'

export const MAPPED_TOOLS = Object.freeze(['write', 'edit', 'apply_patch', 'str_replace_editor'])

/** @param {unknown} value @returns {string | undefined} */
function textField(value) {
  return typeof value === 'string' ? value : undefined
}

/** @param {string} rawPath */
function resolvePath(rawPath, cwd) {
  return path.resolve(cwd, rawPath)
}

/**
 * Extract the lines a full-file write removes from its prior content.
 * @param {string} content
 * @param {{ file_path: string, content: string }} args
 * @returns {{ text: string, line: number }[]}
 */
function writeDeletions(content, args) {
  return removedLines(content, typeof args.content === 'string' ? args.content : '')
}

/**
 * Parse an apply_patch string into file sections. This is intentionally a
 * tolerant reader: a malformed patch is rejected by the tool itself; the gate
 * only needs paths and removed lines, and it must not invent targets.
 * @param {string} input
 * @returns {{ kind: 'add'|'update'|'delete', path: string, moveTo?: string, deletions: string[] }[]}
 */
export function parsePatch(input) {
  const lines = splitLines(input)
  /** @type {{ kind: 'add'|'update'|'delete', path: string, moveTo?: string, deletions: string[] }[]} */
  const sections = []
  /** @type {null | { kind: 'add'|'update'|'delete', path: string, moveTo?: string, deletions: string[] }} */
  let current = null
  let sawBegin = false
  for (const line of lines) {
    if (line === '*** Begin Patch') {
      sawBegin = true
      continue
    }
    if (line === '*** End Patch') break
    if (line.startsWith('*** Add File: ')) {
      current = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), deletions: [] }
      sections.push(current)
      continue
    }
    if (line.startsWith('*** Update File: ')) {
      current = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), deletions: [] }
      sections.push(current)
      continue
    }
    if (line.startsWith('*** Delete File: ')) {
      current = { kind: 'delete', path: line.slice('*** Delete File: '.length).trim(), deletions: [] }
      sections.push(current)
      continue
    }
    if (line.startsWith('*** Move to: ')) {
      if (current !== null) current.moveTo = line.slice('*** Move to: '.length).trim()
      continue
    }
    if (line === '*** End of File') continue
    if (line.startsWith('@@')) continue
    if (current === null) continue
    if (line.startsWith('*** ')) continue
    if (current.kind === 'update' && line.startsWith('-') && !line.startsWith('---')) {
      current.deletions.push(line.slice(1))
    }
  }
  if (!sawBegin) return []
  return sections.map(section => ({
    ...section,
    path: section.path.replace(/^"(.*)"$/, '$1'),
    ...section.moveTo === undefined ? {} : { moveTo: section.moveTo.replace(/^"(.*)"$/, '$1') },
  }))
}

/**
 * @param {string} toolName
 * @param {Record<string, any>} args
 * @returns {string[]}
 */
export function pathsOf(toolName, args) {
  if (toolName === 'write' || toolName === 'edit') {
    return typeof args?.file_path === 'string' ? [args.file_path] : []
  }
  if (toolName === 'str_replace_editor') {
    return typeof args?.path === 'string' && args.command !== 'view' ? [args.path] : []
  }
  if (toolName === 'apply_patch') {
    if (typeof args?.input !== 'string') return []
    const paths = []
    for (const section of parsePatch(args.input)) {
      paths.push(section.path)
      if (section.moveTo !== undefined) paths.push(section.moveTo)
    }
    return paths
  }
  return []
}

/**
 * Collect concrete targets for one tool call.
 * @param {{
 *   toolName: string,
 *   args: Record<string, any>,
 *   cwd: string,
 *   readFile?: (absolutePath: string) => Promise<string | undefined>,
 * }} options
 * @returns {Promise<{ toolName: string, rawPath: string, absolutePath: string, deletions: { text: string, line: number }[], content?: string, oldText?: string, mayCreate: boolean, source: string }[]>}
 */
export async function collectTargets(options) {
  const { toolName, args, cwd, readFile } = options
  const targets = []
  const push = (target) => {
    if (typeof target.rawPath !== 'string' || target.rawPath.trim() === '') return
    targets.push(target)
  }

  if (toolName === 'write') {
    const rawPath = textField(args?.file_path)
    if (rawPath !== undefined) {
      const absolutePath = resolvePath(rawPath, cwd)
      const content = readFile === undefined ? undefined : await readFile(absolutePath)
      push({
        toolName,
        rawPath,
        absolutePath,
        deletions: content === undefined ? [] : writeDeletions(content, args),
        ...content === undefined ? {} : { content },
        mayCreate: true,
        source: 'write',
      })
    }
  } else if (toolName === 'edit') {
    const rawPath = textField(args?.file_path)
    if (rawPath !== undefined) {
      const oldText = textField(args?.old_string) ?? ''
      const newText = textField(args?.new_string) ?? ''
      push({
        toolName,
        rawPath,
        absolutePath: resolvePath(rawPath, cwd),
        deletions: removedLines(oldText, newText).map(({ text }) => ({ text, line: 0 })),
        ...oldText === '' ? {} : { oldText },
        mayCreate: false,
        source: 'edit',
      })
    }
  } else if (toolName === 'str_replace_editor') {
    const rawPath = textField(args?.path)
    const command = textField(args?.command)
    if (rawPath !== undefined && command !== 'view') {
      let deletions = []
      let oldText
      if (command === 'str_replace') {
        oldText = textField(args?.old_str) ?? ''
        deletions = removedLines(oldText, textField(args?.new_str) ?? '')
          .map(({ text }) => ({ text, line: 0 }))
      }
      push({
        toolName,
        rawPath,
        absolutePath: resolvePath(rawPath, cwd),
        deletions,
        ...oldText === undefined || oldText === '' ? {} : { oldText },
        mayCreate: command === 'create',
        source: command === 'create' ? 'create' : command === 'str_replace' ? 'edit' : 'insert',
      })
    }
  } else if (toolName === 'apply_patch') {
    const input = textField(args?.input)
    if (input !== undefined) {
      /** @type {Map<string, any>} */
      const byPath = new Map()
      for (const section of parsePatch(input)) {
        const rawPath = section.path
        const absolutePath = resolvePath(rawPath, cwd)
        let target = byPath.get(absolutePath)
        if (target === undefined) {
          target = {
            toolName,
            rawPath,
            absolutePath,
            deletions: [],
            mayCreate: section.kind === 'add',
            source: 'patch',
            patchKind: section.kind,
            ...section.moveTo === undefined ? {} : { moveTo: section.moveTo },
          }
          byPath.set(absolutePath, target)
        }
        if (section.kind === 'add') target.mayCreate = true
        if (section.kind === 'delete') {
          target.patchKind = 'delete'
          const content = readFile === undefined ? undefined : await readFile(absolutePath)
          if (content !== undefined) {
            target.content = content
            target.deletions = splitLines(content).map((text, index) => ({ text, line: index + 1 }))
          }
        } else if (section.kind === 'update') {
          target.deletions.push(...section.deletions.map(text => ({ text, line: 0 })))
        }
        if (section.moveTo !== undefined) {
          const destinationAbsolute = resolvePath(section.moveTo, cwd)
          if (!byPath.has(destinationAbsolute)) {
            byPath.set(destinationAbsolute, {
              toolName,
              rawPath: section.moveTo,
              absolutePath: destinationAbsolute,
              deletions: [],
              mayCreate: true,
              source: 'patch',
              patchKind: 'move-destination',
            })
          }
        }
      }
      targets.push(...byPath.values())
    }
  }
  return targets
}
