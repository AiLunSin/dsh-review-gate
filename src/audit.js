/**
 * Local, body-free JSONL audit trail.
 *
 * Records are queued and flushed asynchronously; a filesystem failure warns once
 * and never changes a tool result. The writer copies only an allowlisted set of
 * fields, so a caller cannot accidentally persist file contents.
 * @module dsh-review-gate/audit
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ALLOWED_FIELDS = new Set([
  'v',
  'type',
  'ts',
  'sessionId',
  'tool',
  'toolName',
  'callId',
  'requestId',
  'decision',
  'code',
  'reason',
  'path',
  'scope',
  'scopeSource',
  'rules',
  'deleted',
  'snippetHash',
  'approval',
  'degraded',
  'warnings',
  'unscoped',
  'outcome',
  'kind',
  'durationMs',
])

/** @param {Date} date @returns {string} */
export function localDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** @param {Record<string, unknown>} record @returns {Record<string, unknown>} */
function pick(record) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(record)) {
    if (ALLOWED_FIELDS.has(key) && record[key] !== undefined) out[key] = record[key]
  }
  return out
}

/** @returns {string} */
export function defaultHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
}

/**
 * @param {{
 *   enabled: boolean,
 *   dir: string,
 *   maxFileBytes: number,
 *   queueLimit: number,
 *   logger?: { warn?: (...args: any[]) => void },
 *   now?: () => Date,
 * }} options
 */
export class AuditLog {
  constructor(options) {
    this.enabled = options.enabled
    this.dir = options.dir === '' ? path.join(defaultHome(), 'review-gate', 'audit') : options.dir
    this.maxFileBytes = options.maxFileBytes
    this.queueLimit = options.queueLimit
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
    /** @type {string[]} */
    this.queue = []
    this.closed = false
    this.scheduled = false
    this.warned = false
    this.dropped = 0
    this.currentFile = ''
    this.currentBytes = 0
    this.part = 1
    this.chain = Promise.resolve()
  }

  /**
   * Queue one record.
   * @param {Record<string, unknown>} record
   */
  record(record) {
    if (!this.enabled || this.closed) return
    if (this.queue.length >= this.queueLimit) {
      this.dropped += 1
      return
    }
    this.queue.push(`${JSON.stringify(pick(record))}\n`)
    this.schedule()
  }

  schedule() {
    if (this.scheduled || this.closed) return
    this.scheduled = true
    this.chain = this.chain.then(async () => {
      this.scheduled = false
      await this.flushOnce()
    })
  }

  async flushOnce() {
    if (this.queue.length === 0) return
    const lines = this.queue
    this.queue = []
    try {
      await this.writeLines(lines)
    } catch (error) {
      this.warn(error)
    }
  }

  /** @param {string[]} lines */
  async writeLines(lines) {
    await fsp.mkdir(this.dir, { recursive: true })
    for (const line of lines) {
      const bytes = Buffer.byteLength(line, 'utf8')
      if (this.currentFile === '' || this.currentBytes + bytes > this.maxFileBytes) {
        this.currentFile = this.nextFile()
        this.currentBytes = 0
      }
      await fsp.appendFile(this.currentFile, line, 'utf8')
      this.currentBytes += bytes
    }
  }

  /** @returns {string} */
  nextFile() {
    const date = localDate(this.now())
    if (this.currentFile === '' || !this.currentFile.includes(`audit-${date}`)) {
      this.part = 1
    } else {
      this.part += 1
    }
    const suffix = this.part === 1 ? '' : `-${String(this.part).padStart(2, '0')}`
    return path.join(this.dir, `audit-${date}${suffix}.jsonl`)
  }

  /** @param {unknown} error */
  warn(error) {
    if (this.warned) return
    this.warned = true
    this.logger?.warn?.('[review-gate] audit write failed; continuing without audit:', error)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await this.chain
    await this.flushOnce()
  }
}
