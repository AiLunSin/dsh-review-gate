/**
 * Body-free snapshots of one turn's change summary.
 *
 * DSH keeps `workspaceChanges` summaries in the Host process only, so a restart
 * turns a persisted `review-gate/changes` projection into a 404. Keeping the
 * file list and counts lets the tab show that turn again, explicitly labelled
 * as a snapshot. Only paths, counts, and flags are stored: never file contents,
 * diffs, or decision-hint text.
 * @module dsh-review-gate/snapshots
 */

import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { defaultHome } from './audit.js'

const MAX_ENTRIES = 20
const MAX_FILES = 2_000
const SNAPSHOT_FILE = /^[0-9a-f]{16}-\d{10}\.json$/

/** @returns {string} */
export function defaultSnapshotDir() {
  return path.join(defaultHome(), 'review-gate', 'snapshots')
}

/**
 * Keep only the metadata fields the tab renders.
 * @param {any} file
 * @returns {{ path: string, display?: string, added: number, deleted: number, binary?: true, oversized?: true }}
 */
function pickFile(file) {
  /** @type {any} */
  const out = {
    path: String(file?.path ?? ''),
    added: Number.isFinite(file?.added) ? file.added : 0,
    deleted: Number.isFinite(file?.deleted) ? file.deleted : 0,
  }
  if (typeof file?.display === 'string' && file.display !== '') out.display = file.display
  if (file?.binary === true) out.binary = true
  if (file?.oversized === true) out.oversized = true
  return out
}

/** @param {string} sessionId @returns {string} */
function sessionKey(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
}

/** @param {unknown} value @returns {value is { type: string, name: string }} */
function isFileEntry(value) {
  return typeof value === 'object' && value !== null && /** @type {any} */ (value).isFile?.() === true
}

/**
 * Best-effort JSON snapshot store. Every filesystem failure is swallowed: a
 * missing or unreadable snapshot only returns `undefined`, which lets the tab
 * fall back to the empty state.
 */
export class ChangeSnapshots {
  /**
   * @param {{ dir?: string, logger?: { warn?: (...args: any[]) => void } }} [options]
   */
  constructor(options = {}) {
    this.dir = options.dir === undefined || options.dir === '' ? defaultSnapshotDir() : options.dir
    this.logger = options.logger
    this.warned = false
  }

  /** @param {string} sessionId @param {number} seq */
  filePath(sessionId, seq) {
    return path.join(this.dir, `${sessionKey(sessionId)}-${String(seq).padStart(10, '0')}.json`)
  }

  /**
   * Persist the renderable part of a successful review response.
   * @param {string} sessionId
   * @param {number} seq
   * @param {{ turn?: number, total?: number, added?: number, deleted?: number, files?: any[] }} payload
   * @returns {Promise<void>}
   */
  async capture(sessionId, seq, payload) {
    try {
      const files = Array.isArray(payload?.files) ? payload.files : []
      if (files.length > MAX_FILES) return
      const record = {
        v: 1,
        sessionId,
        seq,
        turn: Number.isSafeInteger(payload?.turn) ? payload.turn : 0,
        total: Number.isFinite(payload?.total) ? payload.total : files.length,
        added: Number.isFinite(payload?.added) ? payload.added : 0,
        deleted: Number.isFinite(payload?.deleted) ? payload.deleted : 0,
        capturedAt: new Date().toISOString(),
        files: files.map(pickFile),
      }
      await fsp.mkdir(this.dir, { recursive: true })
      const target = this.filePath(sessionId, seq)
      const temp = `${target}.${process.pid}.tmp`
      await fsp.writeFile(temp, `${JSON.stringify(record)}\n`, 'utf8')
      await fsp.rename(temp, target)
      await this.prune()
    } catch (error) {
      this.warnOnce('[review-gate] snapshot capture failed:', error)
    }
  }

  /**
   * @param {string} sessionId
   * @param {number} seq
   * @returns {Promise<{ turn: number, total: number, added: number, deleted: number, capturedAt: string, files: any[] } | undefined>}
   */
  async read(sessionId, seq) {
    let text
    try {
      text = await fsp.readFile(this.filePath(sessionId, seq), 'utf8')
    } catch {
      return undefined
    }
    let value
    try {
      value = JSON.parse(text)
    } catch {
      return undefined
    }
    if (value?.v !== 1 || value?.sessionId !== sessionId || value?.seq !== seq) return undefined
    if (!Number.isSafeInteger(value.turn) || value.turn < 0) return undefined
    if (!Array.isArray(value.files) || value.files.length > MAX_FILES) return undefined
    const files = []
    for (const file of value.files) {
      if (typeof file?.path !== 'string' || file.path === '') return undefined
      if (!Number.isFinite(file.added) || !Number.isFinite(file.deleted)) return undefined
      files.push(pickFile(file))
    }
    return {
      turn: value.turn,
      total: Number.isFinite(value.total) ? value.total : files.length,
      added: Number.isFinite(value.added) ? value.added : 0,
      deleted: Number.isFinite(value.deleted) ? value.deleted : 0,
      capturedAt: typeof value.capturedAt === 'string' ? value.capturedAt : '',
      files,
    }
  }

  /** Keep the newest MAX_ENTRIES snapshot files. @returns {Promise<void>} */
  async prune() {
    try {
      const entries = await fsp.readdir(this.dir, { withFileTypes: true })
      const files = entries.filter(isFileEntry).filter(entry => SNAPSHOT_FILE.test(entry.name))
      if (files.length <= MAX_ENTRIES) return
      const stats = await Promise.all(files.map(async entry => ({
        name: entry.name,
        mtime: (await fsp.stat(path.join(this.dir, entry.name))).mtimeMs,
      })))
      stats.sort((left, right) => right.mtime - left.mtime || right.name.localeCompare(left.name))
      for (const stale of stats.slice(MAX_ENTRIES)) {
        await fsp.rm(path.join(this.dir, stale.name), { force: true })
      }
    } catch (error) {
      this.warnOnce('[review-gate] snapshot prune failed:', error)
    }
  }

  /** @param {...any} args */
  warnOnce(...args) {
    if (this.warned) return
    this.warned = true
    this.logger?.warn?.(...args)
  }
}
