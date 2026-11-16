/**
 * `/review-scope` command: declare, inspect, or clear the session's write scope.
 * @module dsh-review-gate/commands
 */

import { translate } from './locale.js'
import { describeScope, parseScopeCommand, readScopeState, SCOPE_COMMAND } from './scope.js'

/**
 * @param {{
 *   config: any,
 *   locale: 'zh' | 'en',
 *   scopeHandle: any,
 * }} options
 */
export function createReviewScopeCommand(options) {
  const { config, locale, scopeHandle } = options
  const t = (key, params) => translate(locale, key, params)
  return {
    name: SCOPE_COMMAND,
    description: locale === 'zh'
      ? '声明本次允许修改的路径范围（写入前边界控制）'
      : 'Declare the paths this session may modify (pre-write boundary control)',
    input: { hint: 'src/auth/**  !src/**/*.test.*  |  clear' },
    /**
     * @param {{ agent: any, rawInput: string }} invocation
     * @returns {{ kind: 'success', text: string } | { kind: 'error', text: string }}
     */
    handler(invocation) {
      const parsed = parseScopeCommand(invocation.rawInput)
      if (parsed.kind === 'error') {
        return { kind: 'error', text: t('command.error', { message: parsed.message }) }
      }
      if (scopeHandle === undefined) {
        return {
          kind: 'error',
          text: locale === 'zh'
            ? '范围状态不可用：当前 DSH 缺少 sessionProjections 服务。'
            : 'Scope state is unavailable: this DSH does not expose sessionProjections.',
        }
      }
      if (parsed.kind === 'query') {
        const state = readScopeState(scopeHandle, invocation.agent?.session, config)
        return {
          kind: 'success',
          text: t('command.query', {
            source: t(`command.source.${state.source}`),
            count: state.globs.length,
            globs: describeScope(state, locale),
          }),
        }
      }
      if (parsed.kind === 'clear') {
        return { kind: 'success', text: t('command.clear') }
      }
      return {
        kind: 'success',
        text: t('command.set', {
          count: parsed.globs.length,
          globs: parsed.globs.join('  '),
        }),
      }
    },
  }
}
