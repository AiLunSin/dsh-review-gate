import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import {
  compileProtected,
  compileScope,
  globToRegExp,
  GlobError,
  parseScopeToken,
  relativePath,
  splitScopeTokens,
} from '../src/glob.js'

const cwd = path.resolve('/w')
const abs = value => path.resolve(cwd, value)

test('glob: ** matches any depth', () => {
  const scope = compileScope(['src/**'])
  assert.equal(scope.inScope(abs('src/a.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/x/y/z.ts'), cwd), true)
  assert.equal(scope.inScope(abs('lib/a.ts'), cwd), false)
  assert.equal(scope.inScope(abs('src'), cwd), false)
})

test('glob: * is one segment only', () => {
  const scope = compileScope(['src/*.ts'])
  assert.equal(scope.inScope(abs('src/a.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/sub/a.ts'), cwd), false)
})

test('glob: **/ in the middle matches zero or more segments', () => {
  const scope = compileScope(['src/**/auth.ts'])
  assert.equal(scope.inScope(abs('src/auth.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/x/auth.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/x/y/auth.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/x/other.ts'), cwd), false)
})

test('glob: leading **/ matches root and nested files', () => {
  const scope = compileScope(['**/*.test.*'])
  assert.equal(scope.inScope(abs('a.test.ts'), cwd), true)
  assert.equal(scope.inScope(abs('x/y/a.test.js'), cwd), true)
  assert.equal(scope.inScope(abs('a.ts'), cwd), false)
})

test('glob: ? matches one character inside a segment', () => {
  const scope = compileScope(['src/a?.ts'])
  assert.equal(scope.inScope(abs('src/ab.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/abc.ts'), cwd), false)
  assert.equal(scope.inScope(abs('src/a/b.ts'), cwd), false)
})

test('glob: brace alternatives', () => {
  const scope = compileScope(['src/{auth,login}/**'])
  assert.equal(scope.inScope(abs('src/auth/a.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/login/a.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/utils/a.ts'), cwd), false)
})

test('glob: character class', () => {
  const scope = compileScope(['src/[ab].ts'])
  assert.equal(scope.inScope(abs('src/a.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/b.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/c.ts'), cwd), false)
})

test('glob: negation excludes a matching path', () => {
  const scope = compileScope(['src/**', '!src/**/*.test.ts'])
  assert.equal(scope.inScope(abs('src/auth/a.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/auth/a.test.ts'), cwd), false)
  assert.equal(scope.inScope(abs('src/a.ts'), cwd), true)
})

test('glob: exclusion-only scope allows everything else', () => {
  const scope = compileScope(['!**/*.test.ts'])
  assert.equal(scope.inScope(abs('src/a.ts'), cwd), true)
  assert.equal(scope.inScope(abs('src/a.test.ts'), cwd), false)
})

test('glob: absolute patterns are matched against the absolute path', () => {
  const scope = compileScope([`${cwd.replace(/\\/g, '/')}/src/**`])
  assert.equal(scope.inScope(abs('src/a.ts'), cwd), true)
  assert.equal(scope.inScope(abs('lib/a.ts'), cwd), false)
})

test('glob: case-insensitive by default, sensitive when requested', () => {
  const insensitive = compileScope(['SRC/**'])
  assert.equal(insensitive.inScope(abs('src/a.ts'), cwd), true)
  const sensitive = compileScope(['SRC/**'], { caseSensitive: true })
  assert.equal(sensitive.inScope(abs('src/a.ts'), cwd), false)
})

test('glob: empty scope matches everything (caller treats it as disabled)', () => {
  assert.equal(compileScope([]).inScope(abs('anything.go'), cwd), true)
})

test('glob: path outside cwd does not match a relative pattern', () => {
  const scope = compileScope(['src/**'])
  assert.equal(scope.inScope(path.resolve(cwd, '..', 'src', 'a.ts'), cwd), false)
})

test('glob: malformed patterns throw GlobError', () => {
  assert.throws(() => globToRegExp('src/{a,b'), GlobError)
  assert.throws(() => globToRegExp('src/[ab'), GlobError)
  assert.throws(() => globToRegExp(''), GlobError)
  assert.throws(() => globToRegExp('src/[a/b].ts'), GlobError)
})

test('glob: nested braces are rejected', () => {
  assert.throws(() => globToRegExp('src/{a,{b,c}}'), GlobError)
})

test('glob: parseScopeToken handles negation and rejects a bare bang', () => {
  assert.deepEqual(parseScopeToken('src/**'), { pattern: 'src/**', negated: false })
  assert.deepEqual(parseScopeToken('!src/**'), { pattern: 'src/**', negated: true })
  assert.throws(() => parseScopeToken('!'), GlobError)
  assert.throws(() => parseScopeToken('   '), GlobError)
})

test('glob: protected patterns match .git and key files', () => {
  const protectedMatcher = compileProtected(['.git/**', '**/.git/**', '**/*.pem', '**/*.key'])
  assert.equal(protectedMatcher.matches(abs('.git/config'), cwd), true)
  assert.equal(protectedMatcher.matches(abs('nested/.git/HEAD'), cwd), true)
  assert.equal(protectedMatcher.matches(abs('certs/server.pem'), cwd), true)
  assert.equal(protectedMatcher.matches(abs('certs/server.KEY'), cwd), true)
  assert.equal(protectedMatcher.matches(abs('.gitignore'), cwd), false)
})

test('glob: protected patterns reject negation', () => {
  assert.throws(() => compileProtected(['!src/**']), GlobError)
})

test('glob: relativePath preserves escape segments', () => {
  assert.equal(relativePath(abs('src/a.ts'), cwd), 'src/a.ts')
  assert.equal(relativePath(path.resolve(cwd, '..', 'a.ts'), cwd), '../a.ts')
})

test('glob: splitScopeTokens splits on whitespace and drops empties', () => {
  assert.deepEqual(splitScopeTokens('  src/**   !src/x  '), ['src/**', '!src/x'])
  assert.deepEqual(splitScopeTokens(''), [])
})
