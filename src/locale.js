/**
 * Host-side text. The Host has no readable UI locale service, so
 * `config.locale` (or the process locale) decides command echoes and denial
 * reasons. Approval titles carry both `en` and `zh` and are resolved by the
 * Client locale service.
 * @module dsh-review-gate/locale
 */

const EN = {
  'command.usage': 'Usage: /review-scope <glob...> | /review-scope clear',
  'command.query': 'Current scope ({source}, {count}): {globs}',
  'command.set': 'Scope updated ({count}): {globs}',
  'command.clear': 'Scope cleared. Out-of-scope writes are no longer gated (they are still audited).',
  'command.error': 'Invalid scope: {message}',
  'command.source.command': 'command',
  'command.source.config': 'config',
  'command.source.none': 'not declared',
  'command.unscoped': 'none',
  'deny.protected': 'protected path: {path}',
  'deny.scope': 'out-of-scope write: {path} (declared: {scope})',
  'deny.rule': 'sensitive deletion: {path} (rule {rule})',
  'deny.approval': 'approval prompts are disabled, so this {kind} requires approval and is denied',
  'display.scope': 'Out-of-scope write: {path} (scope: {scope})',
  'display.rule': 'Sensitive deletion: {path} ({count} line(s), rule {rule})',
  'display.mixed': 'Out-of-scope write + sensitive deletion: {path} (scope: {scope}; rules {rules})',
}

const ZH = {
  'command.usage': '用法：/review-scope <glob...> | /review-scope clear',
  'command.query': '当前范围（{source}，{count} 条）：{globs}',
  'command.set': '范围已更新（{count} 条）：{globs}',
  'command.clear': '范围已清除；越界写入不再拦截（但仍审计）。',
  'command.error': '范围无效：{message}',
  'command.source.command': '命令声明',
  'command.source.config': '配置默认',
  'command.source.none': '未声明',
  'command.unscoped': '无',
  'deny.protected': '受保护路径：{path}',
  'deny.scope': '越界写入：{path}（已声明范围：{scope}）',
  'deny.rule': '敏感删除：{path}（规则 {rule}）',
  'deny.approval': '审批已关闭，本次{kind}需要审批，因此拒绝',
  'display.scope': '越界写入：{path}（范围：{scope}）',
  'display.rule': '敏感删除：{path}（删除 {count} 行，规则 {rule}）',
  'display.mixed': '越界写入且命中敏感删除：{path}（范围：{scope}；规则 {rules}）',
}

export const HOST_LOCALES = Object.freeze({ en: EN, zh: ZH })

/**
 * Resolve the Host locale from config, then `$DSH_LOCALE`, then LC_ALL/LANG,
 * then the JS runtime default. Chinese tags map to `zh`; everything else to `en`.
 * @param {{ locale?: 'auto' | 'zh' | 'en' }} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'zh' | 'en'}
 */
export function resolveHostLocale(config, env = process.env) {
  if (config?.locale === 'zh' || config?.locale === 'en') return config.locale
  const raw = env.DSH_LOCALE || env.LC_ALL || env.LC_MESSAGES || env.LANG
  if (typeof raw === 'string' && raw.toLowerCase().startsWith('zh')) return 'zh'
  try {
    const resolved = new Intl.DateTimeFormat().resolvedOptions().locale
    return String(resolved).toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

/**
 * @param {'zh' | 'en'} locale
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function translate(locale, key, params) {
  const dictionary = HOST_LOCALES[locale === 'zh' ? 'zh' : 'en']
  const template = dictionary[key] ?? EN[key]
  if (template === undefined) return key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * @param {'zh' | 'en'} locale
 * @returns {(key: string, params?: Record<string, string | number>) => string}
 */
export function translator(locale) {
  return (key, params) => translate(locale, key, params)
}
