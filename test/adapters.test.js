import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import {
  collectTargets,
  MAPPED_TOOLS,
  parsePatch,
  pathsOf,
} from '../src/adapters.js'
import { removedLines } from '../src/util.js'

const cwd = path.resolve('/w')
const abs = value => path.resolve(cwd, value)

test('utils: removedLines subtracts a multiset and keeps line numbers', () => {
  assert.deepEqual(removedLines('a\nb\nc\n', 'a\nc\n'), [{ text: 'b', line: 2 }])
  assert.deepEqual(removedLines('a\na\nb', 'a\nb'), [{ text: 'a', line: 2 }])
  assert.deepEqual(removedLines('a\n', 'a\n'), [])
})

test('adapters: mapped tools are exactly the file mutators', () => {
  assert.deepEqual([...MAPPED_TOOLS], ['write', 'edit', 'apply_patch', 'str_replace_editor'])
})

test('adapters: write resolves the path and reads the old file for deletions', async () => {
  const [target] = await collectTargets({
    toolName: 'write',
    args: { file_path: 'src/a.ts', content: 'keep\nnew\n' },
    cwd,
    readFile: async () => 'keep\nold\n',
  })
  assert.equal(target.absolutePath, abs('src/a.ts'))
  assert.deepEqual(target.deletions, [{ text: 'old', line: 2 }])
  assert.equal(target.mayCreate, true)
  assert.equal(target.content, 'keep\nold\n')
})

test('adapters: write to a missing file has no deletions and no content', async () => {
  const [target] = await collectTargets({
    toolName: 'write',
    args: { file_path: 'src/new.ts', content: 'x' },
    cwd,
    readFile: async () => undefined,
  })
  assert.deepEqual(target.deletions, [])
  assert.equal(target.content, undefined)
})

test('adapters: edit extracts removed old_string lines', async () => {
  const [target] = await collectTargets({
    toolName: 'edit',
    args: {
      file_path: 'src/a.ts',
      old_string: 'if (!user.hasPermission("admin")) {\n  return 403\n}\nkeep\n',
      new_string: 'keep\n',
    },
    cwd,
  })
  assert.equal(target.absolutePath, abs('src/a.ts'))
  assert.deepEqual(target.deletions.map(item => item.text), [
    'if (!user.hasPermission("admin")) {',
    '  return 403',
    '}',
  ])
  assert.equal(target.source, 'edit')
  assert.equal(target.mayCreate, false)
})

test('adapters: str_replace_editor handles view/create/str_replace', async () => {
  assert.deepEqual(pathsOf('str_replace_editor', { command: 'view', path: '/w/a.ts' }), [])
  const [created] = await collectTargets({
    toolName: 'str_replace_editor',
    args: { command: 'create', path: abs('a.ts'), file_text: 'x' },
    cwd,
  })
  assert.equal(created.mayCreate, true)
  assert.deepEqual(created.deletions, [])
  const [replaced] = await collectTargets({
    toolName: 'str_replace_editor',
    args: {
      command: 'str_replace',
      path: abs('a.ts'),
      old_str: 'hasPermission(x)\nkeep',
      new_str: 'keep',
    },
    cwd,
  })
  assert.deepEqual(replaced.deletions, [{ text: 'hasPermission(x)', line: 0 }])
  assert.equal(replaced.source, 'edit')
})

test('adapters: apply_patch parses add/update/delete/move sections', () => {
  const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
-if (!user.hasPermission("admin")) {
-  return 403
+if (ok) {
*** Move to: src/b.ts
*** Add File: src/c.ts
+hello
*** Delete File: src/d.ts
*** End Patch`
  const sections = parsePatch(patch)
  assert.equal(sections.length, 3)
  assert.deepEqual(sections[0].deletions, ['if (!user.hasPermission("admin")) {', '  return 403'])
  assert.equal(sections[0].moveTo, 'src/b.ts')
  assert.equal(sections[1].kind, 'add')
  assert.equal(sections[2].kind, 'delete')
})

test('adapters: apply_patch collectTargets includes move destination and delete content', async () => {
  const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
-secret()
+ok()
*** Move to: src/b.ts
*** Delete File: src/d.ts
*** End Patch`
  const targets = await collectTargets({
    toolName: 'apply_patch',
    args: { input: patch },
    cwd,
    readFile: async file => file.endsWith('d.ts') ? 'a\nsecret()\n' : undefined,
  })
  const byPath = new Map(targets.map(target => [target.relativePath ?? target.rawPath, target]))
  assert.ok(targets.some(target => target.absolutePath === abs('src/b.ts') && target.mayCreate === true))
  const deleted = targets.find(target => target.absolutePath === abs('src/d.ts'))
  assert.ok(deleted)
  assert.deepEqual(deleted.deletions.map(item => item.text), ['a', 'secret()'])
  assert.ok(byPath.size >= 3)
})

test('adapters: malformed apply_patch has no targets', async () => {
  const targets = await collectTargets({
    toolName: 'apply_patch',
    args: { input: 'not a patch' },
    cwd,
  })
  assert.deepEqual(targets, [])
})

test('adapters: unknown tools and missing paths resolve to no targets', async () => {
  assert.deepEqual(pathsOf('read', { file_path: 'x' }), [])
  assert.deepEqual(pathsOf('write', {}), [])
  assert.deepEqual(await collectTargets({ toolName: 'write', args: {}, cwd }), [])
})
