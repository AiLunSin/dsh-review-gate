import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../src/index.js'
import { createFakeHost } from './helpers.js'

function execFor(host, { tool = 'write', args, id = 'call-1' } = {}) {
  return {
    name: tool,
    arguments: args,
    callId: id,
    signal: new AbortController().signal,
    agent: { session: { id: 'session-1', header: { cwd: host.cwd } } },
  }
}

const approvalAsk = { overrideOf: () => 'ask', config: { policy: 'ask' } }
const approvalNever = { overrideOf: () => 'never', config: { policy: 'ask' } }

test('plugin: apply registers the projection, command, gate, guard, and fs safety net', async () => {
  const host = createFakeHost({
    scopeState: { globs: ['src/auth/**'], source: 'command' },
    approval: approvalAsk,
  })
  await apply(host.ctx, { audit: { enabled: false } })
  assert.equal(host.listenersFor('tools/pre-execute').length, 1)
  assert.equal(host.listenersFor('fs/write-intent').length, 1)
  assert.equal(host.listenersFor('fs/edit-intent').length, 1)
  assert.equal(host.listenersFor('fs/delete-intent').length, 1)
  assert.equal(host.listenersFor('session/event').length, 1)
  assert.equal(host.commands.length, 1)
  assert.equal(host.commands[0].name, 'review-scope')
  assert.equal(host.guards.length, 1)
  assert.ok(host.projectionDefinition)
  assert.equal(host.projectionDefinition.key, 'review-gate/scope')
})

test('plugin: out-of-scope write asks through pre-execute with both locales', async () => {
  const host = createFakeHost({
    scopeState: { globs: ['src/auth/**'], source: 'command' },
    approval: approvalAsk,
  })
  await apply(host.ctx, { audit: { enabled: false } })
  const decision = await host.runPreExecute(execFor(host, {
    args: { file_path: 'src/utils/a.ts', content: 'x' },
  }))
  assert.equal(decision.kind, 'ask')
  assert.match(decision.displayReason.en, /Out-of-scope/)
  assert.match(decision.displayReason.zh, /越界/)
})

test('plugin: in-scope write calls next() and does not return an allow decision', async () => {
  const host = createFakeHost({
    scopeState: { globs: ['src/auth/**'], source: 'command' },
    approval: approvalAsk,
  })
  await apply(host.ctx, { audit: { enabled: false } })
  let nextCalls = 0
  const entries = host.listenersFor('tools/pre-execute')
  const decision = await entries[0](execFor(host, {
    args: { file_path: 'src/auth/a.ts', content: 'x' },
  }), async () => {
    nextCalls += 1
    return { kind: 'allow' }
  })
  assert.equal(nextCalls, 1)
  assert.deepEqual(decision, { kind: 'allow' })
})

test('plugin: never policy denies an out-of-scope write by default', async () => {
  const host = createFakeHost({
    scopeState: { globs: ['src/auth/**'], source: 'command' },
    approval: approvalNever,
  })
  await apply(host.ctx, { audit: { enabled: false } })
  const decision = await host.runPreExecute(execFor(host, {
    args: { file_path: 'src/utils/a.ts', content: 'x' },
  }))
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.code, 'REVIEW_GATE_APPROVAL_UNAVAILABLE')
})

test('plugin: onApprovalUnavailable=allow degrades to allow under never', async () => {
  const host = createFakeHost({
    scopeState: { globs: ['src/auth/**'], source: 'command' },
    approval: approvalNever,
  })
  await apply(host.ctx, { onApprovalUnavailable: 'allow', audit: { enabled: false } })
  const decision = await host.runPreExecute(execFor(host, {
    args: { file_path: 'src/utils/a.ts', content: 'x' },
  }))
  assert.deepEqual(decision, { kind: 'allow' })
})

test('plugin: fs safety net denies unmapped tools out of scope and lets mapped tools through', async () => {
  const host = createFakeHost({
    scopeState: { globs: ['src/auth/**'], source: 'command' },
    approval: approvalAsk,
  })
  await apply(host.ctx, { audit: { enabled: false } })
  const target = { displayPath: path.resolve(host.cwd, 'src/utils/a.ts') }
  const unmappedActor = {
    name: 'mcp_fs',
    agent: { session: { id: 'session-1', header: { cwd: host.cwd } } },
  }
  await assert.rejects(
    host.runFsIntent('write', target, unmappedActor),
    error => error?.name === 'ReviewGateError' && error.code === 'REVIEW_GATE_SCOPE_DENIED',
  )
  const mappedActor = {
    name: 'write',
    agent: { session: { id: 'session-1', header: { cwd: host.cwd } } },
  }
  const result = await host.runFsIntent('write', target, mappedActor)
  assert.equal(result.nextCalled, true)
})

test('plugin: fs safety net rejects a protected path for an unknown writer', async () => {
  const host = createFakeHost({ approval: approvalAsk })
  await apply(host.ctx, { audit: { enabled: false } })
  const target = { displayPath: path.resolve(host.cwd, '.git/config') }
  const actor = { name: 'mcp_fs', agent: { session: { id: 's', header: { cwd: host.cwd } } } }
  await assert.rejects(
    host.runFsIntent('write', target, actor),
    error => error?.code === 'REVIEW_GATE_PROTECTED',
  )
})

test('plugin: fs safety net delegates to the next listener', async () => {
  const host = createFakeHost({ approval: approvalAsk })
  await apply(host.ctx, { audit: { enabled: false } })
  const listener = host.listenersFor('fs/write-intent')[0]
  const target = { displayPath: path.resolve(host.cwd, 'src/auth/a.ts') }
  const actor = { name: 'mcp_fs', agent: { session: { id: 's', header: { cwd: host.cwd } } } }
  let secondCalled = false
  const intent = await listener(target, actor, async () => {
    secondCalled = true
    return { kind: 'createIfAbsent' }
  })
  assert.equal(secondCalled, true)
  assert.deepEqual(intent, { kind: 'createIfAbsent' })
})

test('plugin: fs safety net does not swallow a later policy error', async () => {
  const host = createFakeHost({ approval: approvalAsk })
  await apply(host.ctx, { audit: { enabled: false } })
  const listener = host.listenersFor('fs/write-intent')[0]
  const target = { displayPath: path.resolve(host.cwd, 'src/auth/a.ts') }
  const actor = { name: 'mcp_fs', agent: { session: { id: 's', header: { cwd: host.cwd } } } }
  let calls = 0
  await assert.rejects(
    listener(target, actor, () => {
      calls += 1
      throw new Error('later policy rejected')
    }),
    /later policy rejected/,
  )
  assert.equal(calls, 1)
})

test('plugin: fs safety net uses the resolved target key to catch symlink escapes', async () => {
  const host = createFakeHost({ approval: approvalAsk })
  await apply(host.ctx, { audit: { enabled: false } })
  const target = {
    displayPath: path.resolve(host.cwd, 'src/auth/link.txt'),
    targetKey: path.resolve(host.cwd, '.git/config'),
  }
  const actor = { name: 'mcp_fs', agent: { session: { id: 's', header: { cwd: host.cwd } } } }
  await assert.rejects(
    host.runFsIntent('write', target, actor),
    error => error?.code === 'REVIEW_GATE_PROTECTED',
  )
})

test('plugin: synchronous guard denies protected paths for mapped tools', async () => {
  const host = createFakeHost({ approval: approvalAsk })
  await apply(host.ctx, { audit: { enabled: false } })
  const guard = host.guards[0]
  const denial = guard(execFor(host, { args: { file_path: '.git/config', content: 'x' } }))
  assert.equal(denial.info.code, 'REVIEW_GATE_PROTECTED')
  assert.equal(guard(execFor(host, { tool: 'read', args: {} })), undefined)
})

test('plugin: /review-scope query returns the current state and set returns success', async () => {
  const host = createFakeHost({
    scopeState: { globs: ['src/auth/**'], source: 'command' },
    approval: approvalAsk,
  })
  await apply(host.ctx, { audit: { enabled: false } })
  const command = host.commands[0]
  const query = command.handler({ agent: { session: {} }, rawInput: '' })
  assert.match(query.text, /src\/auth\/\*\*/)
  const set = command.handler({ agent: { session: {} }, rawInput: 'src/**' })
  assert.equal(set.kind, 'success')
  const error = command.handler({ agent: { session: {} }, rawInput: 'src/{a' })
  assert.equal(error.kind, 'error')
})

test('plugin: disabled config installs nothing', async () => {
  const host = createFakeHost()
  await apply(host.ctx, { enabled: false })
  assert.equal(host.listenersFor('tools/pre-execute').length, 0)
  assert.equal(host.commands.length, 0)
  assert.equal(host.guards.length, 0)
})

test('plugin: invalid config fails activation', async () => {
  const host = createFakeHost()
  await assert.rejects(apply(host.ctx, { onApprovalUnavailable: 'maybe' }), /onApprovalUnavailable/)
})

test('plugin: unload removes listeners, commands, and the guard', async () => {
  const host = createFakeHost({ approval: approvalAsk })
  await apply(host.ctx, { audit: { enabled: false } })
  host.dispose()
  assert.equal(host.listenersFor('tools/pre-execute').length, 0)
  assert.equal(host.listenersFor('fs/write-intent').length, 0)
  assert.equal(host.commands.length, 0)
  assert.equal(host.guards.length, 0)
})

test('plugin: approval outcome is audited after an ask', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'review-gate-approval-'))
  try {
    const host = createFakeHost({
      scopeState: { globs: ['src/auth/**'], source: 'command' },
      approval: approvalAsk,
    })
    await apply(host.ctx, { audit: { enabled: true, dir } })
    const decision = await host.runPreExecute(execFor(host, {
      args: { file_path: 'src/utils/a.ts', content: 'x' },
    }))
    assert.equal(decision.kind, 'ask')
    const observer = host.listenersFor('session/event')[0]
    assert.ok(observer)
    const session = { id: 'session-1' }
    observer(session, { type: 'approval/asked', data: { id: 'req-1', callId: 'call-1', toolName: 'write' } })
    observer(session, { type: 'approval/decided', data: { id: 'req-1', outcome: 'rejected' } })
    await new Promise(resolve => setTimeout(resolve, 30))
    host.dispose()
    await new Promise(resolve => setTimeout(resolve, 30))
    const files = await fsp.readdir(dir)
    const records = (await fsp.readFile(path.join(dir, files[0]), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    const approval = records.find(record => record.type === 'approval')
    assert.ok(approval)
    assert.equal(approval.outcome, 'rejected')
    assert.equal(approval.callId, 'call-1')
    assert.equal(approval.toolName, 'write')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('plugin: audit records an ask without file contents', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'review-gate-plugin-'))
  try {
    const host = createFakeHost({
      scopeState: { globs: ['src/auth/**'], source: 'command' },
      approval: approvalAsk,
    })
    await apply(host.ctx, {
      scope: { default: ['src/auth/**'] },
      audit: { enabled: true, dir },
    })
    await host.runPreExecute(execFor(host, {
      args: { file_path: 'src/utils/a.ts', content: 'TOP SECRET' },
    }))
    await new Promise(resolve => setTimeout(resolve, 50))
    host.dispose()
    await new Promise(resolve => setTimeout(resolve, 50))
    const files = await fsp.readdir(dir)
    assert.equal(files.length, 1)
    const text = await fsp.readFile(path.join(dir, files[0]), 'utf8')
    assert.match(text, /"decision":"ask"/)
    assert.equal(text.includes('TOP SECRET'), false)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
