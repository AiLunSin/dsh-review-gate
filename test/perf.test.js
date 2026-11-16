import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { decide } from '../src/decide.js'
import { resolveConfig } from '../src/config.js'
import { compileProtected } from '../src/glob.js'
import { resolveRuleset } from '../src/rules.js'

const cwd = path.resolve('/w')

test('performance: 2k in-scope write decisions stay well under budget', async () => {
  const config = resolveConfig({ scope: { default: ['src/auth/**'] } })
  const ruleset = resolveRuleset(config)
  const protectedMatcher = compileProtected(config.protectedPaths, { caseSensitive: false })
  const ctx = {
    get(service) {
      if (service === 'workingDirectory') return { get: () => cwd }
      if (service === 'approval') return { overrideOf: () => 'ask', config: { policy: 'ask' } }
      return undefined
    },
    logger: { warn() {} },
  }
  const exec = {
    name: 'write',
    arguments: { file_path: 'src/auth/a.ts', content: 'x' },
    callId: 'call-1',
    signal: new AbortController().signal,
    agent: { session: { id: 's', header: { cwd } } },
  }
  const deps = {
    ctx,
    config,
    locale: 'en',
    scopeHandle: { stateOf: () => ({ globs: ['src/auth/**'], source: 'command' }) },
    ruleset,
    protectedMatcher,
    exec,
  }
  const samples = []
  for (let index = 0; index < 2000; index += 1) {
    const started = performance.now()
    const { verdict } = await decide(deps)
    samples.push(performance.now() - started)
    assert.equal(verdict.kind, 'allow')
  }
  samples.sort((left, right) => left - right)
  const p95 = samples[Math.floor(samples.length * 0.95)]
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
  assert.ok(mean < 10, `mean decision time ${mean.toFixed(3)}ms exceeded 10ms`)
  assert.ok(p95 < 50, `p95 decision time ${p95.toFixed(3)}ms exceeded 50ms`)
})
