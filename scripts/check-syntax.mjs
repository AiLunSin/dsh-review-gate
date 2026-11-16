#!/usr/bin/env node
/**
 * Dependency-free syntax and manifest check used by `npm run lint` and CI.
 * It does not execute plugin code; `node --check` covers parse errors and the
 * JSON checks cover manifests/locales/index.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const roots = ['src', 'test', 'e2e', 'scripts']
const jsFiles = []

/** @param {string} dir */
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) jsFiles.push(full)
  }
}

for (const relative of roots) {
  const dir = path.join(root, relative)
  try {
    if (statSync(dir).isDirectory()) walk(dir)
  } catch {
    // Optional directories (e2e is present in the repo, absent in some checkouts).
  }
}

for (const file of jsFiles) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
}

const jsonFiles = [
  path.join(root, 'package.json'),
  path.join(root, 'index.json'),
  ...readdirSync(path.join(root, 'locale')).filter(name => name.endsWith('.json')).map(name => path.join(root, 'locale', name)),
]
for (const file of jsonFiles) {
  JSON.parse(readFileSync(file, 'utf8'))
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('package.json dsh.bundle.patch must be ./cordis.patch.yml')
if (!pkg.exports?.['.']) throw new Error('package.json must export "."')
if (pkg.dsh?.client !== undefined) {
  if (!pkg.exports?.['./client']) throw new Error('dsh.client requires the ./client export')
  if (!pkg.files?.includes('client.js')) throw new Error('dsh.client requires client.js in files')
}
for (const required of ['index.js', 'LICENSE', 'README.md', 'cordis.patch.yml', 'icon.svg']) {
  const full = required === 'index.js' ? path.join(root, 'src', 'index.js') : path.join(root, required)
  readFileSync(full)
}
console.log(`checked ${jsFiles.length} JavaScript files and ${jsonFiles.length} JSON files`)
