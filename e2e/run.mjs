/**
 * Real DeepSeek Harness end-to-end verification for dsh-review-gate P0.
 *
 * Requirements:
 *   DSH_INSTALL_DIR       the installed @deepseek-ai/dsh package directory
 *   DSH_NODE_EXECUTABLE   the Electron binary (Desktop) or a node runtime
 *
 * Creates a throwaway DSH_HOME and headless profile, installs this bundle plus
 * a scripted LLM, runs one real turn, and checks the gate decisions, files,
 * and audit trail. No model account, network, or token spend.
 *
 * Usage: npm run e2e [-- --keep]
 * @module dsh-review-gate/e2e
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installDir = process.env.DSH_INSTALL_DIR
const nodeExecutable = process.env.DSH_NODE_EXECUTABLE ?? process.execPath
const keep = process.argv.includes('--keep')
const cli = path.join(installDir ?? '', 'lib', 'bin.js')
const inAsar = cli.includes('.asar')

if (!installDir || (!inAsar && !existsSync(cli))) {
  console.error('e2e: DSH_INSTALL_DIR must point at the installed @deepseek-ai/dsh package.')
  console.error('     Desktop builds also need DSH_NODE_EXECUTABLE (the Electron binary).')
  process.exit(2)
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'review-gate-e2e-'))
const home = path.join(temp, 'home')
const work = path.join(temp, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })

/** @param {string[]} args @param {{ cwd?: string, timeout?: number }} [options] */
function runCli(args, options = {}) {
  const result = spawnSync(nodeExecutable, [cli, ...args], {
    cwd: options.cwd ?? temp,
    env: {
      ...process.env,
      DSH_HOME: home,
      ELECTRON_RUN_AS_NODE: '1',
    },
    encoding: 'utf8',
    timeout: options.timeout ?? 240_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return result
}

/** @param {string[]} args @param {{ cwd?: string }} [options] */
function mustRun(args, options = {}) {
  const result = runCli(args, options)
  if (result.status !== 0) {
    throw new Error(`DSH exited ${result.status}: ${(result.stderr || result.stdout || '').slice(0, 3000)}`)
  }
  return result
}

/** @param {string} file @returns {any[]} */
function decodeSessionLog(file) {
  const bytes = readFileSync(file)
  const text = file.endsWith('.zstd') ? zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch {}
  }
  return events
}

/** @param {string} dir @returns {string[]} */
function findSessionLogs(dir) {
  /** @type {string[]} */
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findSessionLogs(full))
    else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) found.push(full)
  }
  return found
}

function writeProfilePatch() {
  const profileDir = path.join(home, 'profiles', 'e2e')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '# Installed test fixtures and a deterministic approval policy.',
    '- insert:',
    '    - id: fake-llm-review-gate',
    '      name: dsh-fake-llm-review-gate',
    '    - id: fake-fs-tool',
    '      name: dsh-fake-fs-tool',
    '    - id: fake-scope-command',
    '      name: dsh-fake-scope-command',
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: fake',
    '    model: fake-1',
    '- id: approval',
    "  name: '@deepseek-ai/dsh-user-approval'",
    '  config:',
    '    policy: never',
    '- id: review-gate',
    "  name: '@ailunsin/dsh-review-gate'",
    '  config:',
    '    onApprovalUnavailable: deny',
    '    audit:',
    '      enabled: true',
    '',
  ].join('\n'))
}

/** @param {any[]} events @param {string} type */
function eventsOf(events, type) {
  return events.filter(event => event?.type === type)
}

try {
  console.log('e2e: creating a throwaway headless profile')
  mustRun(['--profile', 'e2e', '--from-default-profile', 'headless', '--dump-config'])
  mustRun(['plugin', '--profile', 'e2e', 'add', repoRoot, path.join(repoRoot, 'e2e', 'fake-llm'), path.join(repoRoot, 'e2e', 'fake-tool'), path.join(repoRoot, 'e2e', 'fake-command')])
  writeProfilePatch()

  console.log('e2e: running the scripted turn')
  const run = mustRun(['--profile', 'e2e', 'Run the scripted verification sequence.'], { cwd: work })
  assert.match(run.stdout, /E2E script finished after five tool calls\./)

  const logs = findSessionLogs(home)
  assert.ok(logs.length > 0, 'the headless turn must leave a Session log')
  logs.sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs)
  const events = decodeSessionLog(logs[logs.length - 1])
  const results = eventsOf(events, 'tool/result')
  assert.equal(results.length, 5, `expected five tool results, got ${results.length}`)
  const failures = results.filter(result => result.data?.message?.isError === true
    || result.data?.isError === true
    || result.data?.error !== undefined)
  assert.equal(failures.length, 3, `expected three denied tool calls, got ${failures.length}`)
  const coded = failures
    .map(result => result.data?.error?.info?.code ?? result.data?.error?.code)
    .filter(code => typeof code === 'string')
    .sort()
  assert.deepEqual(coded, [
    'REVIEW_GATE_APPROVAL_UNAVAILABLE',
    'REVIEW_GATE_APPROVAL_UNAVAILABLE',
  ])
  // A plain thrown Error is normalized without structured `info`; the model-facing
  // text still carries the marker, and the audit row carries the stable code.
  const fsFailure = failures.find(result => JSON.stringify(result.data?.message?.content ?? '').includes('fs-intent=write'))
  assert.ok(fsFailure, 'the unmapped fs tool must be denied with the fs-intent marker')

  assert.equal(existsSync(path.join(work, 'src/utils/helper.ts')), false, 'out-of-scope write must not land')
  assert.equal(existsSync(path.join(work, 'src/utils/mcp.ts')), false, 'fs safety net write must not land')
  const inScope = path.join(work, 'src/auth/login.ts')
  assert.equal(existsSync(inScope), true, 'in-scope write must land')
  assert.equal(readFileSync(inScope, 'utf8'), 'if (!user.hasPermission("admin")) return deny()\n', 'the denied edit must not change the file')

  const auditDir = path.join(home, 'review-gate', 'audit')
  const auditFiles = readdirSync(auditDir).sort()
  assert.equal(auditFiles.length, 1)
  const audit = readFileSync(path.join(auditDir, auditFiles[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const commandRuns = events.filter(event => event.type === 'command/run' && event.data?.name === 'review-scope')
  assert.ok(commandRuns.length >= 1, '/review-scope must be recorded as a durable command/run event')
  assert.match(commandRuns[0].data.args, /src\/auth\/\*\*/)
  const decisions = audit.filter(record => record.type === 'decision')
  assert.equal(decisions.length, 3, `expected three audited decisions, got ${decisions.length}`)
  assert.ok(decisions.every(record => record.scopeSource === 'command'), 'the scope must come from the command projection, not config')
  assert.equal(decisions.filter(record => record.decision === 'deny').length, 2)
  assert.equal(decisions.filter(record => record.decision === 'allow').length, 1)
  assert.ok(decisions.every(record => record.approval === 'never' || record.decision === 'allow'), 'denials must record the never policy')
  const fsDenials = audit.filter(record => record.type === 'fs-intent' && record.decision === 'deny')
  assert.equal(fsDenials.length, 1)
  assert.equal(fsDenials[0].code, 'REVIEW_GATE_SCOPE_DENIED')
  assert.equal(JSON.stringify(audit).includes('hasPermission'), false, 'audit must not store deleted source text')

  console.log('e2e: PASS pre-execute deny/allow + fs safety net + audit + no out-of-scope file')
  console.log(`e2e: OK (${temp})`)
} catch (error) {
  console.error(`e2e: FAIL — ${error instanceof Error ? error.message : String(error)}`)
  if (process.env.E2E_DEBUG === '1') {
    const logs = existsSync(home) ? findSessionLogs(home) : []
    for (const log of logs) {
      console.error(`--- ${log}`)
      for (const event of decodeSessionLog(log)) {
        if (event?.type === 'tool/result') console.error(JSON.stringify(event.data))
      }
    }
    console.error(`temp: ${temp}`)
  }
  process.exitCode = 1
} finally {
  if (!keep && process.exitCode !== 1) rmSync(temp, { recursive: true, force: true })
  else console.error(`e2e: kept ${temp}`)
}
