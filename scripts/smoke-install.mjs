#!/usr/bin/env node
/**
 * Smoke-check a built release directory: manifest/files, npm pack contents, and
 * (when a DSH installation is available) installation into a throwaway profile.
 *
 * Usage: node scripts/smoke-install.mjs [--dir dist/ailunsin--dsh-review-gate]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const dirArg = args.indexOf('--dir')
const distDir = path.resolve(root, dirArg >= 0 ? args[dirArg + 1] : path.join('dist', 'ailunsin--dsh-review-gate'))

function fail(message) {
  console.error(`smoke-install: ${message}`)
  process.exit(1)
}

if (!existsSync(path.join(distDir, 'package.json'))) fail(`missing built package: ${distDir} (run npm run build:release)`)

const pkg = JSON.parse(readFileSync(path.join(distDir, 'package.json'), 'utf8'))
if (pkg.name !== '@ailunsin/dsh-review-gate') fail(`unexpected package name: ${pkg.name}`)
if (pkg.private === true) fail('built package must not be private')
if (pkg.engines?.dsh !== '0.2.2-rc.3') fail(`unexpected engines.dsh: ${pkg.engines?.dsh}`)
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('missing dsh.bundle.patch')
if (pkg.dsh?.client !== undefined) {
  if (!pkg.exports?.['./client']) fail('dsh.client without ./client export')
  if (!existsSync(path.join(distDir, 'client.js'))) fail('dsh.client without client.js')
  if (!pkg.files?.includes('client.js')) fail('client.js is not in the published files list')
}

for (const file of [
  'src/index.js',
  'client.js',
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'SECURITY.md',
  'docs/decisions.md',
  'docs/spike-m0.md',
]) {
  if (!existsSync(path.join(distDir, file))) fail(`missing published file: ${file}`)
}

// A stale dist shipped pre-fix code once; compare the copied runtime sources with
// the checkout before declaring the artifact publishable.
for (const file of ['src/index.js', 'src/interceptors.js', 'src/decide.js', 'src/glob.js', 'src/adapters.js', 'src/rules.js', 'client.js']) {
  const source = readFileSync(path.join(root, file))
  const built = readFileSync(path.join(distDir, file))
  if (!source.equals(built)) fail(`stale build: ${file} differs from the checkout (re-run build:release)`)
}

const patch = readFileSync(path.join(distDir, 'cordis.patch.yml'), 'utf8')
if (!patch.includes("name: '@ailunsin/dsh-review-gate'")) fail('cordis.patch.yml does not name the package')
if (!patch.includes('id: review-gate')) fail('cordis.patch.yml does not insert the review-gate row')

const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packed = existsSync(npmCli)
  ? spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
    cwd: distDir,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, npm_config_loglevel: 'error' },
  })
  : spawnSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: distDir,
    encoding: 'utf8',
    timeout: 180_000,
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_loglevel: 'error' },
  })
if (packed.status !== 0) fail(`npm pack --dry-run failed: ${(packed.stderr || packed.stdout || '').slice(0, 2000)}`)
const manifest = JSON.parse(packed.stdout)[0]
const files = new Set(manifest.files.map(file => file.path))
for (const required of ['package.json', 'src/index.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'README.md']) {
  if (!files.has(required)) fail(`npm pack omitted ${required}`)
}
for (const forbidden of ['test/glob.test.js', 'e2e/run.mjs', 'scripts/build-release.mjs']) {
  if (files.has(forbidden)) fail(`npm pack should not include ${forbidden}`)
}

/**
 * Resolve how to start the DSH CLI. The npm-style install exposes
 * `<installDir>/lib/bin.js`; the Desktop build keeps the CLI inside app.asar and
 * ships `resources/runtime/cli/bin/dsh.cmd`, which is only a wrapper that sets
 * ELECTRON_RUN_AS_NODE and runs the Electron binary against
 * `<app.asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`.
 * Plain Node cannot stat paths inside app.asar, so probe the exe and the asar.
 */
function resolveDshRunner() {
  const installDir = process.env.DSH_INSTALL_DIR
  const nodeExecutable = process.env.DSH_NODE_EXECUTABLE
  if (installDir && nodeExecutable) {
    const cli = path.join(installDir, 'lib', 'bin.js')
    if (existsSync(cli)) return { label: `DSH_INSTALL_DIR ${installDir}`, command: nodeExecutable, entry: cli }
    console.warn(`smoke-install: ${cli} not found, probing the Desktop layout instead`)
  }
  if (process.platform !== 'win32') return null
  const roots = [
    process.env.DSH_DESKTOP_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness') : null,
  ].filter(Boolean)
  for (const root of roots) {
    const command = path.join(root, 'DeepSeek Harness.exe')
    const entry = path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    if (existsSync(command) && existsSync(path.join(root, 'resources', 'app.asar'))) {
      return { label: `Desktop ${root}`, command, entry }
    }
  }
  return null
}

const runner = resolveDshRunner()
if (runner) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'review-gate-smoke-'))
  const home = path.join(temp, 'home')
  const run = (argv) => spawnSync(runner.command, [runner.entry, ...argv], {
    cwd: temp,
    env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  try {
    const created = run(['--profile', 'smoke', '--from-default-profile', 'headless', '--dump-config'])
    if (created.status !== 0) fail(`profile creation failed: ${(created.stderr || created.stdout).slice(0, 2000)}`)
    const added = run(['plugin', '--profile', 'smoke', 'add', distDir])
    if (added.status !== 0) fail(`plugin add failed: ${(added.stderr || added.stdout).slice(0, 2000)}`)
    const dumped = run(['--profile', 'smoke', '--dump-config'])
    if (dumped.status !== 0) fail(`dump-config failed: ${(dumped.stderr || dumped.stdout).slice(0, 2000)}`)
    if (!dumped.stdout.includes("name: '@ailunsin/dsh-review-gate'")) fail('composed profile does not mention the package')
    if (!dumped.stdout.includes('id: review-gate')) fail('composed profile does not insert review-gate')
    console.log(`smoke-install: PASS manifest + npm pack + temp-profile install (${runner.label})`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
} else {
  console.log('smoke-install: PASS manifest + npm pack (profile install skipped: DSH CLI not found)')
}
