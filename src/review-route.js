/**
 * Authenticated Host route for P2 review units and decision hints.
 *
 * The client fetches this exact route before falling back to the built-in
 * `/api/changes.summary` + P1 directory grouping. Registration goes through
 * Connection's authenticated Fetch fence, so only the owner Peer reaches it.
 * @module dsh-review-gate/review-route
 */

import path from 'node:path'
import {
  decisionApplies,
  decisionHints,
  parseDecisionComments,
  parseInstructionDecisions,
  parseMarkdownDecisions,
  removedLinesFromDiff,
} from './decisions.js'
import { buildImportEdges, buildReviewUnits } from './review-units.js'

export const REVIEW_UNITS_ROUTE = '/api/review-gate.units'
const MAX_READ_FILES = 40
const MAX_READ_BYTES = 65_536
const MAX_DECISION_FILES = 20
const MAX_DIFF_FILES = 8

/**
 * Register the route if the profile composes a browser-facing Connection.
 * @param {any} ctx
 * @param {{ review: { importGraph: boolean, decisionSources: string[], maxUnits: number, entryPatterns: string[] } }} config
 */
export function registerReviewRoute(ctx, config) {
  const connection = ctx.get?.('connection')
  if (connection === undefined || typeof connection.fetch?.register !== 'function') return
  let dispose
  try {
    dispose = connection.fetch.register({
      path: REVIEW_UNITS_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => handleReviewRequest({ ctx, config, request }),
    })
  } catch (error) {
    ctx.logger?.warn?.('[review-gate] review route unavailable:', error)
    return
  }
  ctx.effect(() => () => { void dispose() }, 'review-gate: /api/review-gate.units')
}

/** @param {unknown} value */
function safeInteger(value) {
  return typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

/**
 * Read one workspace-relative text file through the FS seam, bounded.
 * @param {any} fs
 * @param {string} cwd
 * @param {string} relativePath
 * @param {AbortSignal} signal
 * @returns {Promise<string | undefined>}
 */
async function readBounded(fs, cwd, relativePath, signal) {
  try {
    const target = await fs.resolve(relativePath, { cwd, signal })
    const info = await fs.stat(target, signal)
    if (info === undefined || info.type !== 'file') return undefined
    if (typeof info.size === 'number' && info.size > MAX_READ_BYTES) return undefined
    const text = await fs.readText(target, signal)
    return typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= MAX_READ_BYTES ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {any} fs
 * @param {string} cwd
 * @param {string} source
 * @param {AbortSignal} signal
 * @param {{ source: string, text: string }[]} out
 * @param {number} depth
 */
async function collectDecisionSource(fs, cwd, source, signal, out, depth = 0) {
  if (out.length >= MAX_DECISION_FILES || depth > 3) return
  const relative = source.replace(/\\/g, '/').replace(/\/+$/, '')
  if (relative === '') return
  let target
  try {
    target = await fs.resolve(relative, { cwd, signal })
  } catch {
    return
  }
  let info
  try {
    info = await fs.stat(target, signal)
  } catch {
    return
  }
  if (info === undefined) return
  if (info.type === 'file') {
    const text = await readBounded(fs, cwd, relative, signal)
    if (text !== undefined) out.push({ source: relative, text })
    return
  }
  if (info.type !== 'directory' || typeof fs.listDir !== 'function') return
  let entries
  try {
    entries = await fs.listDir(target, signal)
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_DECISION_FILES) return
    if (entry.name.startsWith('.')) continue
    const child = `${relative}/${entry.name}`
    if (entry.type === 'directory') await collectDecisionSource(fs, cwd, child, signal, out, depth + 1)
    else if (entry.type === 'file' && /\.(?:md|markdown)$/i.test(entry.name)) {
      const text = await readBounded(fs, cwd, child, signal)
      if (text !== undefined) out.push({ source: child, text })
    }
  }
}

/**
 * @param {{
 *   ctx: any,
 *   config: any,
 *   request: Request,
 * }} options
 * @returns {Promise<Response>}
 */
export async function handleReviewRequest(options) {
  const { ctx, config, request } = options
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const seq = safeInteger(url.searchParams.get('seq'))
  if (sessionId === '' || seq === undefined) return new Response('sessionId and seq are required.', { status: 400 })
  const changes = ctx.get?.('workspaceChanges')
  if (changes === undefined || typeof changes.summary !== 'function') return new Response('Workspace changes unavailable.', { status: 503 })
  const summary = changes.summary(sessionId, seq)
  if (summary === undefined) return new Response('Change summary unavailable.', { status: 404 })
  const signal = request.signal
  const cwd = typeof summary.cwd === 'string' && summary.cwd !== '' ? summary.cwd : process.cwd()
  const files = summary.files.map((file, index) => ({ ...file, path: file.path.replace(/\\/g, '/'), index }))
  const fs = ctx.get?.('fs')

  /** @type {Map<string, string>} */
  const contents = new Map()
  if (fs !== undefined) {
    for (const file of files.slice(0, MAX_READ_FILES)) {
      if (file.binary === true || file.oversized === true) continue
      signal.throwIfAborted()
      const text = await readBounded(fs, cwd, file.path, signal)
      if (text !== undefined) contents.set(file.path, text)
    }
  }

  const edges = config.review.importGraph
    ? buildImportEdges(files.map(file => ({ path: file.path, content: contents.get(file.path) })))
    : new Map()
  const units = buildReviewUnits(files, {
    maxUnits: config.review.maxUnits,
    entryPatterns: config.review.entryPatterns,
    edges,
  })

  /** @type {Map<string, any>} */
  const decisions = new Map()
  if (fs !== undefined && config.review.decisionSources.length > 0) {
    /** @type {{ source: string, text: string }[]} */
    const sources = []
    for (const source of config.review.decisionSources) {
      await collectDecisionSource(fs, cwd, source, signal, sources)
      if (sources.length >= MAX_DECISION_FILES) break
    }
    for (const source of sources) {
      const name = path.posix.basename(source.source).toLowerCase()
      const parsed = name === 'claude.md' || name === 'agents.md'
        ? parseInstructionDecisions(source.text, source.source)
        : parseMarkdownDecisions(source.text, source.source)
      for (const decision of parsed) decisions.set(`${decision.id}\u0000${decision.source}\u0000${decision.line}`, decision)
    }
  }
  for (const [filePath, content] of contents) {
    for (const decision of parseDecisionComments(content, filePath, filePath)) {
      decisions.set(`${decision.id}\u0000${decision.source}\u0000${decision.line}`, decision)
    }
  }
  const decisionList = [...decisions.values()]

  /** @type {Map<string, string[]>} */
  const removedLines = new Map()
  if (decisionList.length > 0 && typeof changes.diff === 'function') {
    const shortlist = new Map()
    for (const decision of decisionList) {
      for (const file of files) {
        if (file.binary === true || file.oversized === true) continue
        if (!decisionApplies(decision.appliesTo, file.path)) continue
        shortlist.set(file.index, file)
        if (shortlist.size >= MAX_DIFF_FILES) break
      }
      if (shortlist.size >= MAX_DIFF_FILES) break
    }
    for (const file of shortlist.values()) {
      signal.throwIfAborted()
      try {
        const diff = await changes.diff(sessionId, seq, file.index, signal)
        removedLines.set(file.path, removedLinesFromDiff(diff))
      } catch {
        // A missing/oversized diff simply yields no hint for that file.
      }
    }
  }
  const hints = decisionHints({ decisions: decisionList, files, removedLines })

  return Response.json({
    mode: edges.size > 0 ? 'graph' : 'directory',
    turn: summary.turn,
    total: summary.total,
    added: summary.added,
    deleted: summary.deleted,
    files,
    units,
    hints,
  }, { headers: { 'cache-control': 'no-store' } })
}
