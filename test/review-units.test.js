import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildImportEdges,
  buildReviewUnits,
  importSpecifiers,
  resolveRelativeImport,
} from '../src/review-units.js'

const entryPatterns = ['**/index.*', '**/main.*']

test('review units: relative JS imports create undirected edges', () => {
  const files = [
    { path: 'src/index.ts', added: 5, deleted: 0 },
    { path: 'src/auth/login.ts', added: 2, deleted: 1 },
    { path: 'src/utils/x.ts', added: 1, deleted: 0 },
  ]
  const edges = buildImportEdges([
    { path: 'src/index.ts', content: "import { login } from './auth/login'\nimport { x } from './utils/x'" },
    { path: 'src/auth/login.ts', content: "import { x } from '../utils/x'" },
    { path: 'src/utils/x.ts', content: 'export const x = 1\n' },
  ])
  assert.equal(edges.get('src/index.ts')?.has('src/auth/login.ts'), true)
  assert.equal(edges.get('src/auth/login.ts')?.has('src/utils/x.ts'), true)
  const units = buildReviewUnits(files, { entryPatterns, edges })
  assert.ok(units.some(unit => unit.entry && unit.files.length === 3))
  const entryUnit = units.find(unit => unit.entry)
  assert.ok(entryUnit.reasons.some(reason => reason.startsWith('imports:')))
})

test('review units: no entry pattern falls back to directory grouping', () => {
  const files = [
    { path: 'src/a.ts', added: 1, deleted: 0 },
    { path: 'src/b.ts', added: 1, deleted: 0 },
    { path: 'lib/c.ts', added: 1, deleted: 0 },
  ]
  const units = buildReviewUnits(files, { entryPatterns: [], edges: new Map() })
  assert.deepEqual(units.map(unit => unit.key).sort(), ['lib', 'src'])
})

test('review units: monorepo grouping keeps the package segment', () => {
  const files = [
    { path: 'packages/client/a.ts', added: 1, deleted: 0 },
    { path: 'packages/client/b.ts', added: 2, deleted: 0 },
    { path: 'packages/server/c.ts', added: 1, deleted: 0 },
  ]
  const units = buildReviewUnits(files, { entryPatterns: [], edges: new Map() })
  assert.deepEqual(units.map(unit => unit.key).sort(), ['packages/client', 'packages/server'])
})

test('review units: overflow merges into one deterministic unit', () => {
  const files = ['a', 'b', 'c', 'd'].map((dir, index) => ({
    path: `${dir}/x.ts`, added: index + 1, deleted: 0, index,
  }))
  const units = buildReviewUnits(files, { entryPatterns: [], edges: new Map(), maxUnits: 2 })
  assert.equal(units.length, 2)
  assert.equal(units[1].key, '__merged__')
  assert.equal(units[1].files.length, 3)
  assert.equal(units[1].reasons[0], 'merged:3')
})

test('review units: TS import of a .js specifier resolves to the .ts file', () => {
  const changed = new Set(['src/a.ts'])
  assert.equal(resolveRelativeImport('src/index.ts', './a.js', changed), 'src/a.ts')
  assert.equal(resolveRelativeImport('src/index.ts', './missing', changed), undefined)
})

test('review units: Python relative imports resolve within packages', () => {
  const changed = new Set(['pkg/core.py', 'pkg/sub/__init__.py'])
  assert.equal(resolveRelativeImport('pkg/__init__.py', '.core', changed), 'pkg/core.py')
  assert.equal(resolveRelativeImport('pkg/__init__.py', '.sub', changed), 'pkg/sub/__init__.py')
})

test('review units: importSpecifiers ignores package imports', () => {
  const specs = importSpecifiers("import x from 'react'\nimport './local'\nconst y = require('../y')\n", 'src/a.ts')
  assert.deepEqual(specs.sort(), ['./local', '../y'].sort())
})
