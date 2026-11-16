#!/usr/bin/env node
/**
 * Validate `index.json` against DSH's official format-1 parser.
 *
 * When a DSH installation is available, the script runs the installed
 * `@deepseek-ai/dsh-plugin-market-index` parser through the Electron Node
 * runtime (plain Node cannot read inside app.asar). Without one it performs a
 * small local structural check and says so; missing official validation is not
 * reported as a pass.
 *
 * Usage:
 *   node scripts/validate-market-index.mjs [--file index.json] [--url https://…/index.json]
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const fileArg = args.indexOf('--file')
const urlArg = args.indexOf('--url')
const root = path.resolve(import.meta.dirname, '..')
const file = path.resolve(root, fileArg >= 0 ? args[fileArg + 1] : 'index.json')
const defaultUrl = 'https://raw.githubusercontent.com/AiLunSin/dsh-review-gate/main/index.json'
const url = urlArg >= 0 ? args[urlArg + 1] : defaultUrl
const value = JSON.parse(readFileSync(file, 'utf8'))

function localCheck() {
  const problems = []
  if (value.format !== 1) problems.push('format must be 1')
  if (typeof value.title !== 'object' || typeof value.title?.en !== 'string') problems.push('title.en is required')
  if (!Array.isArray(value.plugins) || value.plugins.length === 0) problems.push('plugins must be non-empty')
  for (const [index, plugin] of (value.plugins ?? []).entries()) {
    if (typeof plugin.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(plugin.name)) {
      problems.push(`plugins[${index}].name is not an npm package name`)
    }
    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) problems.push(`plugins[${index}].versions is empty`)
    for (const [vIndex, version] of (plugin.versions ?? []).entries()) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.version ?? '')) problems.push(`plugins[${index}].versions[${vIndex}].version is not exact SemVer`)
      if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp <= 0) problems.push(`plugins[${index}].versions[${vIndex}].publishTimestamp must be Unix seconds`)
      if (version.source?.type !== 'npm' && version.source?.type !== 'git') problems.push(`plugins[${index}].versions[${vIndex}].source.type must be npm or git`)
    }
  }
  return problems
}

const installDir = process.env.DSH_INSTALL_DIR
const nodeExecutable = process.env.DSH_NODE_EXECUTABLE
if (installDir && nodeExecutable) {
  const script = `
const { readFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
;(async () => {
  const resolved = require.resolve('@deepseek-ai/dsh-plugin-market-index', { paths: [process.env.DSH_INSTALL_DIR] })
  const mod = await import(pathToFileURL(resolved).href)
  const value = JSON.parse(readFileSync(process.env.DSH_INDEX_FILE, 'utf8'))
  const parsed = mod.parseMarketIndex(value, process.env.DSH_INDEX_URL)
  console.log(JSON.stringify({ plugins: parsed.plugins.length, versions: parsed.plugins.map(p => p.versions.length), icons: parsed.plugins.map(p => p.icon ?? null) }))
})().catch(error => { console.error(error.stack || String(error)); process.exit(1) })
`
  const result = spawnSync(nodeExecutable, ['-e', script], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_INSTALL_DIR: installDir,
      DSH_INDEX_FILE: file,
      DSH_INDEX_URL: url,
    },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    console.error('validate-market-index: FAIL official parser')
    console.error((result.stderr || result.stdout || '').slice(0, 3000))
    process.exit(1)
  }
  const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1))
  console.log(`validate-market-index: PASS official parser (plugins=${parsed.plugins}, versions=${parsed.versions.join(',')})`)
  for (const icon of parsed.icons) {
    if (icon !== null) console.log(`  icon: ${icon}`)
  }
} else {
  const problems = localCheck()
  if (problems.length > 0) {
    console.error('validate-market-index: FAIL local structure')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('validate-market-index: PASS local structure only (DSH installation not available; official parser NOT run)')
}
