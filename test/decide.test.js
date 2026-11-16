import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { decide, remapDeletions, guardDecision } from '../src/decide.js'
import { resolveConfig } from '../src/config.js'
import { compileProtected } from '../src/glob.js'
import { resolveRuleset } from '../src/rules.js'
import { evaluateTarget } from '../src/decide.js'

const cwd = path.resolve('/w')

/**
 * Minimal Host context: working directory, optional fs, optional approval.
 */
function makeCtx({ approval, files = {} } = {}) {
  const fileMap = new Map(Object.entries(files).map(([key, value]) => [path.resolve(cwd, key), value]))
  return {
    get(service) {
      if (service === 'workingDirectory') return { get: () => cwd }
      if (service === 'approval') return approval
      if (service === 'fs') {
        return {
          resolve: async (value, opts) => {
            const absolute = path.resolve(opts?.cwd ?? cwd, value)
            return { targetKey: absolute, displayPath: absolute }
          },
          stat: async target => fileMap.has(target.targetKey)
            ? { type: 'file', size: fileMap.get(target.targetKey).length }
            : undefined,
          readText: async target => fileMap.get(target.targetKey),
        }
      }
      return undefined
    },
    logger: { warn() {} },
  }
}

function makeExec({ tool = 'write', args, cwdValue = cwd, callId = 'call-1' } = {}) {
  return {
    name: tool,
    arguments: args,
    callId,
    signal: new AbortController().signal,
    agent: { session: { id: 'session-1', header: { cwd: cwdValue } } },
  }
}

async function run({ tool = 'write', args, state = { globs: [], source: 'none' }, raw = {}, approval, files } = {}) {
  const config = resolveConfig(raw)
  const ctx = makeCtx({ approval, files })
  const exec = makeExec({ tool, args })
  const result = await decide({
    ctx,
    config,
    locale: raw.locale === 'zh' ? 'zh' : 'en',
    scopeHandle: { stateOf: () => state },
    ruleset: resolveRuleset(config),
    protectedMatcher: compileProtected(config.protectedPaths, { caseSensitive: config.scope.caseSensitive }),
    exec,
  })
  return result
}

test('decide: in-scope clean write is allowed and audited', async () => {
  const { verdict, audit } = await run({
    args: { file_path: 'src/auth/a.ts', content: 'x' },
    state: { globs: ['src/auth/**'], source: 'command' },
  })
  assert.equal(verdict.kind, 'allow')
  assert.equal(audit.decision, 'allow')
  assert.equal(audit.unscoped, false)
  assert.equal(audit.path, 'src/auth/a.ts')
})

test('decide: out-of-scope write asks by default with both locales', async () => {
  const { verdict, audit } = await run({
    args: { file_path: 'src/utils/a.ts', content: 'x' },
    state: { globs: ['src/auth/**'], source: 'command' },
    approval: { overrideOf: () => 'ask', config: { policy: 'ask' } },
  })
  assert.equal(verdict.kind, 'ask')
  assert.match(verdict.displayReason.en, /Out-of-scope write: src\/utils\/a\.ts/)
  assert.match(verdict.displayReason.zh, /越界写入/)
  assert.equal(audit.decision, 'ask')
  assert.deepEqual(audit.rules, [])
})

test('decide: strict scope denies out-of-scope writes', async () => {
  const { verdict, audit } = await run({
    args: { file_path: 'src/utils/a.ts', content: 'x' },
    state: { globs: ['src/auth/**'], source: 'command' },
    raw: { scope: { strict: true } },
    approval: { overrideOf: () => 'ask', config: { policy: 'ask' } },
  })
  assert.equal(verdict.kind, 'deny')
  assert.equal(verdict.info.code, 'REVIEW_GATE_SCOPE_DENIED')
  assert.equal(audit.code, 'REVIEW_GATE_SCOPE_DENIED')
})

test('decide: never policy plus default fallback denies with an approval code', async () => {
  const { verdict } = await run({
    args: { file_path: 'src/utils/a.ts', content: 'x' },
    state: { globs: ['src/auth/**'], source: 'command' },
    approval: { overrideOf: () => 'never', config: { policy: 'ask' } },
  })
  assert.equal(verdict.kind, 'deny')
  assert.equal(verdict.info.code, 'REVIEW_GATE_APPROVAL_UNAVAILABLE')
  assert.match(verdict.reason, /approval prompts are disabled/i)
})

test('decide: never policy plus allow fallback allows, degraded and audited', async () => {
  const { verdict, audit } = await run({
    args: { file_path: 'src/utils/a.ts', content: 'x' },
    state: { globs: ['src/auth/**'], source: 'command' },
    raw: { onApprovalUnavailable: 'allow' },
    approval: { overrideOf: () => 'never', config: { policy: 'ask' } },
  })
  assert.equal(verdict.kind, 'allow')
  assert.equal(audit.degraded, true)
  assert.equal(audit.approval, 'never')
})

test('decide: absent approval service denies by default', async () => {
  const { verdict } = await run({
    args: { file_path: 'src/utils/a.ts', content: 'x' },
    state: { globs: ['src/auth/**'], source: 'command' },
  })
  assert.equal(verdict.kind, 'deny')
  assert.equal(verdict.info.code, 'REVIEW_GATE_APPROVAL_UNAVAILABLE')
})

test('decide: protected paths deny before any approval fallback', async () => {
  const { verdict, audit } = await run({
    args: { file_path: '.git/config', content: 'x' },
    state: { globs: ['.git/**'], source: 'command' },
    raw: { onApprovalUnavailable: 'allow' },
    approval: { overrideOf: () => 'never', config: { policy: 'ask' } },
  })
  assert.equal(verdict.kind, 'deny')
  assert.equal(verdict.info.code, 'REVIEW_GATE_PROTECTED')
  assert.deepEqual(audit.rules, ['RG-PROTECTED'])
})

test('decide: sensitive deletion in scope asks with rule display text', async () => {
  const { verdict, audit } = await run({
    tool: 'edit',
    args: {
      file_path: 'src/auth/login.ts',
      old_string: 'if (!user.hasPermission("admin")) {\n  return 403\n}',
      new_string: '',
    },
    state: { globs: ['src/auth/**'], source: 'command' },
    approval: { overrideOf: () => 'ask', config: { policy: 'ask' } },
  })
  assert.equal(verdict.kind, 'ask')
  assert.match(verdict.displayReason.en, /Sensitive deletion/)
  assert.match(verdict.displayReason.en, /RG-AUTH-001/)
  assert.ok(audit.rules.includes('RG-AUTH-001'))
  assert.ok(audit.deleted >= 3)
})

test('decide: block rules deny even when an approval channel exists', async () => {
  const { verdict } = await run({
    tool: 'edit',
    args: { file_path: 'src/auth/login.ts', old_string: 'hasPermission(x)', new_string: '' },
    state: { globs: ['src/auth/**'], source: 'command' },
    raw: {
      rules: {
        custom: [{
          id: 'RG-AUTH-001',
          severity: 'block',
          patterns: ['hasPermission'],
          appliesTo: ['edit'],
        }],
      },
    },
    approval: { overrideOf: () => 'ask', config: { policy: 'ask' } },
  })
  assert.equal(verdict.kind, 'deny')
  assert.equal(verdict.info.code, 'REVIEW_GATE_RULE_DENIED')
})

test('decide: no declared scope allows but audits unscoped', async () => {
  const { verdict, audit } = await run({
    args: { file_path: 'src/anything.ts', content: 'x' },
  })
  assert.equal(verdict.kind, 'allow')
  assert.equal(audit.unscoped, true)
})

test('decide: unmapped tools pass through untouched', async () => {
  const { verdict, audit } = await run({
    tool: 'bash',
    args: { command: 'rm -rf /' },
    state: { globs: ['src/**'], source: 'command' },
  })
  assert.equal(verdict.kind, 'allow')
  assert.equal(audit.reason, 'unmapped-tool')
})

test('decide: write deletion detection reads the old file and asks', async () => {
  const { verdict, audit } = await run({
    args: {
      file_path: 'src/auth/login.ts',
      content: 'function login() {\n  return ok\n}\n',
    },
    files: {
      'src/auth/login.ts': 'function login() {\n  if (!user.hasPermission("admin")) return deny()\n  return ok\n}\n',
    },
    state: { globs: ['src/auth/**'], source: 'command' },
    approval: { overrideOf: () => 'ask', config: { policy: 'ask' } },
  })
  assert.equal(verdict.kind, 'ask')
  assert.ok(audit.rules.includes('RG-AUTH-001'))
  assert.equal(audit.deleted, 1)
})

test('decide: file-header ignore suppresses rule hits', async () => {
  const { verdict } = await run({
    args: {
      file_path: 'src/auth/login.ts',
      content: 'function login() {\n  return ok\n}\n',
    },
    files: {
      'src/auth/login.ts': '// review-gate-ignore\nif (!user.hasPermission("admin")) return deny()\n',
    },
    state: { globs: ['src/auth/**'], source: 'command' },
    approval: { overrideOf: () => 'ask', config: { policy: 'ask' } },
  })
  assert.equal(verdict.kind, 'allow')
})

test('decide: remapDeletions puts edit hits on file line numbers', async () => {
  const target = {
    toolName: 'edit',
    absolutePath: path.resolve(cwd, 'src/auth/a.ts'),
    deletions: [{ text: 'hasPermission(x)', line: 0 }],
    oldText: 'hasPermission(x)',
    source: 'edit',
  }
  const content = 'line1\nline2\nline3\nline4\nhasPermission(x)\n'
  const result = await evaluateTarget(target, {
    ruleset: resolveRuleset(resolveConfig({})),
    config: resolveConfig({}),
    readFile: async () => content,
    cwd,
  })
  assert.equal(result.hits[0].lines[0], 5)
})

test('decide: resolves ~ through ctx.fs before scope and protected checks', async () => {
  const home = path.resolve(cwd, '..', 'home')
  const expanded = path.join(home, '.ssh', 'config')
  const ctx = {
    get(service) {
      if (service === 'workingDirectory') return { get: () => cwd }
      if (service === 'approval') return { overrideOf: () => 'ask', config: { policy: 'ask' } }
      if (service === 'fs') {
        return {
          resolve: async rawPath => ({
            displayPath: rawPath.startsWith('~') ? path.join(home, rawPath.slice(2)) : path.resolve(cwd, rawPath),
            targetKey: rawPath.startsWith('~') ? path.join(home, rawPath.slice(2)) : path.resolve(cwd, rawPath),
          }),
          stat: async () => undefined,
          readText: async () => undefined,
        }
      }
      return undefined
    },
    logger: { warn() {} },
  }
  const exec = makeExec({ tool: 'write', args: { file_path: '~/.ssh/config', content: 'x' } })
  const baseConfig = resolveConfig({ scope: { default: ['src/**'] } })
  const state = { globs: ['src/**'], source: 'command' }
  const ask = await decide({
    ctx,
    config: baseConfig,
    locale: 'en',
    scopeHandle: { stateOf: () => state },
    ruleset: resolveRuleset(baseConfig),
    protectedMatcher: compileProtected(baseConfig.protectedPaths, { caseSensitive: false }),
    exec,
  })
  assert.equal(ask.verdict.kind, 'ask')
  assert.match(ask.verdict.displayReason.en, /\.ssh\/config/)

  const protectedConfig = resolveConfig({
    scope: { default: ['src/**'] },
    protectedPaths: [`${home.replace(/\\/g, '/')}/.ssh/**`],
  })
  const denied = await decide({
    ctx,
    config: protectedConfig,
    locale: 'en',
    scopeHandle: { stateOf: () => state },
    ruleset: resolveRuleset(protectedConfig),
    protectedMatcher: compileProtected(protectedConfig.protectedPaths, { caseSensitive: false }),
    exec,
  })
  assert.equal(denied.verdict.kind, 'deny')
  assert.equal(denied.verdict.info.code, 'REVIEW_GATE_PROTECTED')
  assert.ok(expanded.length > 0)
})

test('decide: guard denies protected paths synchronously', () => {
  const protectedMatcher = compileProtected(['.git/**', '**/*.pem'])
  const exec = makeExec({ tool: 'write', args: { file_path: 'certs/server.pem', content: 'x' } })
  const denial = guardDecision(exec, cwd, protectedMatcher)
  assert.ok(denial)
  assert.equal(denial.info.code, 'REVIEW_GATE_PROTECTED')
  assert.equal(guardDecision(makeExec({ tool: 'read', args: {} }), cwd, protectedMatcher), undefined)
})
