#!/usr/bin/env node
/**
 * Assert that the published market index and icon are directly reachable from
 * the public raw host with byte-identical content.
 *
 * DSH fetches the index URL exactly as given and rejects redirects, so a 3xx is
 * a failure even though a browser would follow it. raw.githubusercontent.com
 * propagates each push through a CDN, so a fresh push can return stale bytes or
 * 404 for a short while; retry instead of treating that first response as a
 * repository failure.
 *
 * Usage:
 *   node scripts/check-raw-index.mjs
 *   DSH_RAW_BASE=https://raw.githubusercontent.com/<owner>/<repo>/main node scripts/check-raw-index.mjs
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const base = (process.env.DSH_RAW_BASE ?? 'https://raw.githubusercontent.com/AiLunSin/dsh-review-gate/main')
  .replace(/\/+$/, '')
const attempts = Number(process.env.DSH_RAW_ATTEMPTS ?? 20)
const delayMs = Number(process.env.DSH_RAW_DELAY_MS ?? 15_000)
const requestTimeoutMs = 20_000

const targets = [
  { name: 'index.json', url: `${base}/index.json`, contentType: undefined },
  { name: 'icon.svg', url: `${base}/icon.svg`, contentType: /^image\/svg\+xml/i },
]

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const local = new Map()
for (const target of targets) local.set(target.name, await readFile(target.name))

/** @param {{ name: string, url: string, contentType: RegExp | undefined }} target */
async function readRemote(target) {
  const response = await fetch(target.url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  const location = response.headers.get('location')
  if (response.status !== 200) {
    return { ok: false, detail: `status ${response.status}${location === null ? '' : ` location=${location}`}` }
  }
  const body = Buffer.from(await response.arrayBuffer())
  const expected = local.get(target.name)
  const actualSha = sha256(body)
  const expectedSha = sha256(expected)
  if (body.length !== expected.length || actualSha !== expectedSha) {
    return {
      ok: false,
      detail: `${body.length} bytes sha256 ${actualSha} does not match ${expected.length} bytes sha256 ${expectedSha}`,
    }
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (target.contentType !== undefined && !target.contentType.test(contentType)) {
    return { ok: false, detail: `content-type ${JSON.stringify(contentType)} is not ${target.contentType}` }
  }
  return { ok: true, detail: `200 direct, ${body.length} bytes, sha256 ${actualSha}, content-type ${contentType || '(none)'}` }
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const failures = []
  for (const target of targets) {
    try {
      const result = await readRemote(target)
      if (result.ok) console.log(`PASS ${target.name}: ${result.detail}`)
      else failures.push(`${target.name}: ${result.detail}`)
    } catch (error) {
      failures.push(`${target.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length === 0) {
    console.log(`raw assets verified on attempt ${attempt}/${attempts}`)
    process.exit(0)
  }
  console.error(`attempt ${attempt}/${attempts} not ready:`)
  for (const failure of failures) console.error(`  ${failure}`)
  if (attempt < attempts) await sleep(delayMs)
}

throw new Error(`raw assets did not converge after ${attempts} attempts`)
