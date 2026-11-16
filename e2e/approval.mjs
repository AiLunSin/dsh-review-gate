/**
 * Real DeepSeek Harness approval-path e2e.
 *
 * Complements e2e/run.mjs (policy `never`) by composing a test answerer under
 * policy `ask`:
 *   1. out-of-scope write → review-gate ask → answerer rejects → tool error
 *   2. in-scope write → allow
 *   3. read
 *   4. sensitive edit → review-gate ask → answerer allows once → edit lands
 *
 * Requires DSH_INSTALL_DIR and DSH_NODE_EXECUTABLE, like e2e/run.mjs.
 * Usage: npm run e2e:approval [-- --keep]
 * @module dsh-review-gate/e2e/approval
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
  process.exit(2)
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'review-gate-approval-e2e-'))
const home = path.join(temp, 'home')
const work = path.join(temp, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })

/** @param {string[]} args @param {{ cwd?: string }} [options] */
function runCli(args, options = {}) {
  return spawnSync(nodeExecutable, [cli, ...args], {
    cwd: options.cwd ?? temp,
    env: {
      ...process.env,
      DSH_HOME: home,
      ELECTRON_RUN_AS_NODE: '1',
      RG_FAKE_MODE: 'approval',
    },
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 32 * 1024 * 1024,
  })
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
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findSessionLogs(full))
    else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) found.push(full)
  }
  return found
}

function writeProfilePatch() {
  const profileDir = path.join(home, 'profiles', 'approval')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '# Test fixtures: scripted model, approval answerer, command trigger.',
    '- insert:',
    '    - id: fake-llm-review-gate',
    '      name: dsh-fake-llm-review-gate',
    '    - id: fake-approval',
    '      name: dsh-fake-approval',
    '    - id: fake-scope-command',
    '      name: dsh-fake-scope-command',
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: fake',
    '    model: fake-1',
    '- id: review-gate',
    "  name: '@ailunsin/dsh-review-gate'",
    '  config:',
    '    audit:',
    '      enabled: true',
    '',
  ].join('\n'))
}

try {
  console.log('e2e approval: creating a throwaway headless profile')
  mustRun(['--profile', 'approval', '--from-default-profile', 'headless', '--dump-config'])
  mustRun([
    'plugin',
    '--profile',
    'approval',
    'add',
    repoRoot,
    path.join(repoRoot, 'e2e', 'fake-llm'),
    path.join(repoRoot, 'e2e', 'fake-approval'),
    path.join(repoRoot, 'e2e', 'fake-command'),
  ])
  writeProfilePatch()

  console.log('e2e approval: running the scripted turn under policy ask')
  const run = mustRun(['--profile', 'approval', 'Run the approval verification sequence.'], { cwd: work })
  assert.match(run.stdout, /Approval e2e finished after four tool calls\./)

  const logs = findSessionLogs(home)
  assert.ok(logs.length > 0, 'the headless turn must leave a Session log')
  logs.sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs)
  const events = decodeSessionLog(logs[logs.length - 1])
  const results = events.filter(event => event?.type === 'tool/result')
  assert.equal(results.length, 4, `expected four tool results, got ${results.length}`)
  const failures = results.filter(result => result.data?.message?.isError === true
    || result.data?.isError === true
    || result.data?.error !== undefined)
  assert.equal(failures.length, 1, `expected one rejected tool call, got ${failures.length}`)
  const rejected = failures[0]
  const rejectionText = JSON.stringify(rejected.data?.message?.content ?? '')
  assert.match(rejectionText, /rejected/i, 'the rejection must be a human/approval rejection')

  const asked = events.filter(event => event?.type === 'approval/asked')
  const decided = events.filter(event => event?.type === 'approval/decided')
  assert.equal(asked.length, 2, `expected two approval asks, got ${asked.length}`)
  assert.deepEqual(decided.map(event => event.data?.outcome).sort(), ['allowed-once', 'rejected'])

  assert.equal(existsSync(path.join(work, 'src/utils/helper.ts')), false, 'the rejected write must not land')
  const inScope = path.join(work, 'src/auth/login.ts')
  assert.equal(existsSync(inScope), true, 'the in-scope write must land')
  assert.equal(readFileSync(inScope, 'utf8').trim(), '', 'the allowed edit must remove the auth line')

  const auditDir = path.join(home, 'review-gate', 'audit')
  const auditFiles = readdirSync(auditDir).sort()
  assert.equal(auditFiles.length, 1)
  const audit = readFileSync(path.join(auditDir, auditFiles[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const decisions = audit.filter(record => record.type === 'decision')
  assert.equal(decisions.length, 3, `expected three decisions, got ${decisions.length}`)
  assert.ok(decisions.every(record => record.scopeSource === 'command'))
  assert.equal(decisions.filter(record => record.decision === 'ask').length, 2)
  assert.equal(decisions.filter(record => record.decision === 'allow').length, 1)
  const approvals = audit.filter(record => record.type === 'approval')
  assert.equal(approvals.length, 2, 'both ask outcomes must be audited')
  assert.deepEqual(approvals.map(record => record.outcome).sort(), ['allowed-once', 'rejected'])

  console.log('e2e approval: PASS ask → reject + ask → allow + approval audit')
  console.log(`e2e approval: OK (${temp})`)
} catch (error) {
  console.error(`e2e approval: FAIL — ${error instanceof Error ? error.message : String(error)}`)
  if (process.env.E2E_DEBUG === '1') {
    const logs = existsSync(home) ? findSessionLogs(home) : []
    for (const log of logs) {
      console.error(`--- ${log}`)
      for (const event of decodeSessionLog(log)) {
        if (event?.type === 'tool/result' || event?.type === 'approval/asked' || event?.type === 'approval/decided') console.error(JSON.stringify(event))
      }
    }
    console.error(`temp: ${temp}`)
  }
  process.exitCode = 1
} finally {
  if (!keep && process.exitCode !== 1) rmSync(temp, { recursive: true, force: true })
  else console.error(`e2e approval: kept ${temp}`)
}
