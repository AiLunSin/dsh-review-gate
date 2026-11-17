window.__ModuleLoader__.load({
  id: '@ailunsin/dsh-review-gate',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const NS = 'reviewGate'
    const ID = '@ailunsin/dsh-review-gate'
    const KIND = 'review-gate'
    const EMPTY_META = { maxUnits: 5, entryPatterns: ['**/index.*', '**/main.*', '**/app.*', '**/server.*', '**/cli.*', '**/__init__.py', '**/mod.*'] }

    const EN = {
      title: 'Review order',
      guideTitle: 'Review order',
      guideDescription: 'Group this turn\'s changed files into 3–5 review units, entry points first.',
      emptyTitle: 'No changes to review yet',
      emptyBody: 'Run a turn that writes files, then open this tab again.',
      loading: 'Loading changes…',
      missing: 'The Host no longer serves this turn\'s changes.',
      missingBody: 'Run a new turn that writes files to refresh this tab.',
      error: 'Could not load changes: {message}',
      retry: 'Retry',
      turn: 'Turn {turn}',
      files: '{count} files',
      added: '+{count}',
      deleted: '−{count}',
      scope: 'Scope: {scope}',
      noScope: 'No scope declared',
      unit: 'Unit {index} of {count}',
      previous: 'Previous unit',
      next: 'Next unit',
      whyEntry: 'Contains entry file: {names}',
      whyImports: 'Linked by imports ({count} edges)',
      whySize: 'Change size +{added}/−{deleted}',
      whyBinary: 'Contains binary or oversized files',
      whyMerge: 'Remaining {count} files merged into this unit',
      openHint: 'Click a file to open the built-in changes-review tab.',
      openFailed: 'Could not open the review tab: {message}',
      root: 'Root',
      merged: 'Other changes',
      unitFiles: 'Files in this unit',
      ariaUnit: 'Review unit {index}',
      graphMode: 'import graph',
      directoryMode: 'directory grouping',
      decisionTitle: 'Decision hints',
      decisionSuggest: 'Suggestive only: derived from explicit ADR/CLAUDE.md scopes and backticked identifiers in removed lines.',
    }

    const ZH = {
      title: '审查顺序',
      guideTitle: '审查顺序',
      guideDescription: '把本轮改动分成 3–5 个审查单元，入口优先。',
      emptyTitle: '还没有可审查的改动',
      emptyBody: '先跑一轮会写文件的对话，再打开这个页签。',
      loading: '正在加载改动…',
      missing: 'Host 已不再提供本轮的改动数据。',
      missingBody: '请跑一轮新的、会写文件的对话以刷新本页签。',
      error: '加载改动失败：{message}',
      retry: '重试',
      turn: '第 {turn} 轮',
      files: '{count} 个文件',
      added: '+{count}',
      deleted: '−{count}',
      scope: '范围：{scope}',
      noScope: '未声明范围',
      unit: '第 {index}/{count} 组',
      previous: '上一组',
      next: '下一组',
      whyEntry: '包含入口文件：{names}',
      whyImports: '由导入边连接（{count} 条边）',
      whySize: '改动量 +{added}/−{deleted}',
      whyBinary: '包含二进制或超大文件',
      whyMerge: '其余 {count} 个文件合并到本组',
      openHint: '点击文件打开内置 changes-review 页签。',
      openFailed: '无法打开审查页签：{message}',
      root: '根目录',
      merged: '其他改动',
      unitFiles: '本组文件',
      ariaUnit: '审查单元 {index}',
      graphMode: '导入图分组',
      directoryMode: '目录分组',
      decisionTitle: '决策提示',
      decisionSuggest: '仅为建议：来自显式 ADR/CLAUDE.md 范围与被删行中反引号标识符的匹配。',
    }

    const CSS = `
.rg-root { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; max-width: 100%; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 13px; }
.rg-head { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.rg-title-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.rg-title { font-size: 14px; font-weight: 600; }
.rg-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.rg-scope { overflow-wrap: anywhere; }
.rg-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 14px 18px; display: flex; flex-direction: column; gap: 10px; box-sizing: border-box; max-width: 100%; }
.rg-state { padding: 24px 10px; color: var(--dsw-alias-label-secondary); text-align: center; line-height: 1.55; }
.rg-state-left { text-align: left; }
.rg-state-title { color: var(--dsw-alias-label-primary); font-weight: 600; margin-bottom: 4px; }
.rg-units { display: flex; flex-wrap: wrap; gap: 6px; }
.rg-chip { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 3px 9px; font: inherit; font-size: 12px; cursor: pointer; }
.rg-chip[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.rg-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.rg-card-head { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.rg-card-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-weight: 600; overflow-wrap: anywhere; }
.rg-counts { display: flex; gap: 8px; font-size: 12px; white-space: nowrap; }
.rg-add { color: var(--dsw-alias-state-success-primary); }
.rg-del { color: var(--dsw-alias-state-error-primary); }
.rg-why { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.rg-files { list-style: none; margin: 0; padding: 0; }
.rg-file { width: 100%; appearance: none; border: 0; border-top: 1px solid var(--dsw-alias-border-l1); background: transparent; color: inherit; font: inherit; text-align: left; padding: 8px 12px; cursor: pointer; display: flex; align-items: baseline; gap: 10px; }
.rg-file:first-child { border-top: 0; }
.rg-file:hover, .rg-file:focus-visible { background: var(--dsw-alias-bg-layer-2); outline: none; }
.rg-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rg-nav { display: flex; justify-content: space-between; gap: 8px; }
.rg-nav button, .rg-retry { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; }
.rg-nav button:disabled { opacity: 0.45; cursor: default; }
.rg-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.rg-error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.rg-warn { color: var(--dsw-alias-state-warn-primary); }
.rg-section-title { font-weight: 600; font-size: 12px; color: var(--dsw-alias-state-warn-primary); margin-bottom: 2px; }
.rg-decisions { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--dsw-alias-state-warn-primary); border-radius: 10px; padding: 8px 12px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 6%, transparent); }
.rg-decision { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 1.45; }
.rg-decision-text { overflow-wrap: anywhere; }
`

    /** @param {string} locale @param {string} key @param {Record<string, string|number>} [params] */
    function translate(locale, key, params) {
      const dict = locale === 'zh' ? ZH : EN
      const template = dict[key] ?? EN[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => params[name] === undefined ? match : String(params[name]))
    }

    /** @param {string} path @returns {string} */
    function basename(path) {
      const index = path.lastIndexOf('/')
      return index < 0 ? path : path.slice(index + 1)
    }

    /** @param {string} path @returns {string} */
    function dirname(path) {
      const index = path.lastIndexOf('/')
      return index <= 0 ? '' : path.slice(0, index)
    }

    /**
     * Compile the tiny entry-pattern subset the Host config uses (`**`, `*`, `?`).
     * @param {string} pattern
     */
    const entryRegexCache = new Map()
    function entryPatternRegex(pattern) {
      const cached = entryRegexCache.get(pattern)
      if (cached !== undefined) return cached
      let source = '^'
      for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index]
        if (char === '*') {
          if (pattern[index + 1] === '*') {
            if (pattern[index + 2] === '/') {
              source += '(?:.*/)?'
              index += 2
            } else {
              source += '.*'
              index += 1
            }
          } else {
            source += '[^/]*'
          }
        } else if (char === '?') {
          source += '[^/]'
        } else if ('\\^$.|+()[]{}'.includes(char)) {
          source += `\\${char}`
        } else {
          source += char
        }
      }
      const regex = new RegExp(`${source}$`, 'u')
      entryRegexCache.set(pattern, regex)
      return regex
    }

    /** @param {string} path @param {string[]} patterns */
    function isEntry(path, patterns) {
      const name = basename(path)
      return patterns.some((pattern) => {
        try {
          const regex = entryPatternRegex(pattern)
          return regex.test(path) || regex.test(name)
        } catch {
          return false
        }
      })
    }

    /**
     * Group changed files into deterministic review units.
     * @param {{path:string, display?:string, added:number, deleted:number, binary?:true, oversized?:true}[]} files
     * @param {{maxUnits?:number, entryPatterns?:string[]}} [options]
     * @returns {{key:string, title:string, files:any[], added:number, deleted:number, entry:boolean, reasons:string[], merged:number}[]}
     */
    function buildUnits(files, options = {}) {
      const maxUnits = Math.max(1, Math.min(20, Number(options.maxUnits) || 5))
      const entryPatterns = Array.isArray(options.entryPatterns) && options.entryPatterns.length > 0
        ? options.entryPatterns
        : EMPTY_META.entryPatterns
      const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path))
      /** @type {Map<string, any[]>} */
      const groups = new Map()
      for (const file of ordered) {
        const directory = dirname(file.path)
        const segments = directory === '' ? [] : directory.split('/')
        const depth = segments[0] === 'packages' || segments[0] === 'apps' || segments[0] === 'libs' ? 3 : 2
        const key = segments.length === 0 ? '.' : segments.slice(0, depth).join('/')
        const list = groups.get(key) ?? []
        list.push(file)
        groups.set(key, list)
      }
      let units = [...groups.entries()].map(([key, groupFiles]) => {
        const entryFiles = groupFiles.filter(file => isEntry(file.path, entryPatterns))
        const added = groupFiles.reduce((sum, file) => sum + file.added, 0)
        const deleted = groupFiles.reduce((sum, file) => sum + file.deleted, 0)
        const reasons = []
        if (entryFiles.length > 0) reasons.push(`entry:${entryFiles.map(file => basename(file.path)).join(', ')}`)
        reasons.push(`size:${added}:${deleted}`)
        if (groupFiles.some(file => file.binary === true || file.oversized === true)) reasons.push('binary')
        return {
          key,
          title: key === '.' ? translate('en', 'root') : key,
          files: groupFiles,
          added,
          deleted,
          entry: entryFiles.length > 0,
          reasons,
          merged: 0,
        }
      })
      units.sort((left, right) =>
        Number(right.entry) - Number(left.entry)
        || (right.added + right.deleted) - (left.added + left.deleted)
        || left.key.localeCompare(right.key))
      if (units.length > maxUnits) {
        const kept = units.slice(0, maxUnits - 1)
        const rest = units.slice(maxUnits - 1)
        const mergedFiles = rest.flatMap(unit => unit.files)
        const added = rest.reduce((sum, unit) => sum + unit.added, 0)
        const deleted = rest.reduce((sum, unit) => sum + unit.deleted, 0)
        kept.push({
          key: '__merged__',
          title: translate('en', 'merged'),
          files: mergedFiles,
          added,
          deleted,
          entry: false,
          reasons: [`merged:${rest.reduce((sum, unit) => sum + unit.files.length, 0)}`],
          merged: rest.reduce((sum, unit) => sum + unit.files.length, 0),
        })
        units = kept
      }
      return units
    }

    /** Localized reason sentence for one unit. */
    function reasonText(unit, t) {
      return unit.reasons.map((reason) => {
        if (reason.startsWith('entry:')) return t('whyEntry', { names: reason.slice('entry:'.length) })
        if (reason.startsWith('imports:')) return t('whyImports', { count: reason.slice('imports:'.length) })
        if (reason.startsWith('size:')) {
          const [, added, deleted] = reason.split(':')
          return t('whySize', { added, deleted })
        }
        if (reason === 'binary') return t('whyBinary')
        if (reason.startsWith('merged:')) {
          return t('whyMerge', { count: reason.slice('merged:'.length) })
        }
        return reason
      }).join(' · ')
    }

    /** @param {any} unit @param {(key: string, params?: Record<string, string|number>) => string} t */
    function unitTitle(unit, t) {
      if (unit.key === '.') return t('root')
      if (unit.key === '__merged__') return t('merged')
      if (unit.key.startsWith('entry:')) return unit.key.slice('entry:'.length)
      return unit.title
    }

    /** @param {string} value @returns {string} */
    function encodeSession(value) {
      return encodeURIComponent(value)
    }

    /** @param {string} status @returns {boolean} */
    function shouldShowOpenHint(status) {
      return status === 'ready'
    }

    /** @param {any} props */
    function ReviewGateTab(props) {
      const { sessionId, useProjection, useTabInfo } = props
      const changes = useProjection('review-gate/changes') ?? { seq: 0, turn: 0 }
      const scope = useProjection('review-gate/scope')
      const meta = useProjection('review-gate/meta') ?? EMPTY_META
      const t = props.t ?? ((key, params) => translate('en', key, params))
      const [state, setState] = useState({ status: 'idle', data: null, error: null })
      const [selected, setSelected] = useState(0)
      const [reload, setReload] = useState(0)
      const [openError, setOpenError] = useState('')
      const seq = changes.seq
      const bodyRef = useRef(null)

      useEffect(() => {
        if (bodyRef.current !== null) bodyRef.current.scrollTop = 0
      }, [seq, state.status])

      useEffect(() => {
        if (!seq) {
          setState({ status: 'empty', data: null, error: null })
          return undefined
        }
        const controller = new AbortController()
        setState({ status: 'loading', data: null, error: null })
        const query = new URLSearchParams({ sessionId, seq: String(seq) }).toString()
        const load = async () => {
          try {
            const route = await fetch(`api/review-gate.units?${query}`, {
              signal: controller.signal,
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            })
            if (route.ok) {
              const data = await route.json()
              if (data !== null && typeof data === 'object' && Array.isArray(data.units)) {
                return { ...data, hints: Array.isArray(data.hints) ? data.hints : [] }
              }
            }
          } catch (error) {
            if (error?.name === 'AbortError') throw error
            // P1 Host half or a profile without the route: use the built-in summary below.
          }
          const response = await fetch(`api/changes.summary?${query}`, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          })
          if (response.status === 404) throw new Error('missing')
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (data === null || typeof data !== 'object' || !Array.isArray(data.files)) throw new Error('invalid summary')
          const files = data.files.map((file, index) => ({ ...file, index }))
          return { ...data, files, units: null, hints: [] }
        }
        load()
          .then((data) => {
            const files = Array.isArray(data.files)
              ? data.files.map((file, index) => ({ ...file, index }))
              : []
            setState({ status: 'ready', data: { ...data, files }, error: null })
          })
          .catch((error) => {
            if (error?.name === 'AbortError') return
            setState({ status: error?.message === 'missing' ? 'missing' : 'error', data: null, error: String(error?.message ?? error) })
          })
        return () => controller.abort()
      }, [sessionId, seq, reload])

      const files = state.data?.files ?? []
      const serverUnits = Array.isArray(state.data?.units) ? state.data.units : null
      const units = useMemo(
        () => serverUnits ?? buildUnits(files, { maxUnits: meta.maxUnits, entryPatterns: meta.entryPatterns }),
        [serverUnits, files, meta.maxUnits, meta.entryPatterns],
      )
      useEffect(() => {
        if (selected >= units.length) setSelected(0)
      }, [selected, units.length])
      const unit = units[selected]
      const hints = Array.isArray(state.data?.hints) ? state.data.hints : []
      const unitHints = unit === undefined
        ? []
        : hints.filter(hint => unit.files.some(file => file.path === hint.file))
      const tabInfo = useTabInfo()

      if (state.status === 'empty' || state.status === 'idle') {
        return h('div', { className: 'rg-root', 'data-review-gate': '' },
          h('style', null, CSS),
          h('div', { className: 'rg-head' }, h('div', { className: 'rg-title' }, t('title'))),
          h('div', { className: 'rg-body' },
            h('div', { className: 'rg-state' },
              h('div', { className: 'rg-state-title' }, t('emptyTitle')),
              h('div', null, t('emptyBody')))))
      }

      const scopeText = scope === undefined || scope.source === 'none' || scope.globs.length === 0
        ? t('noScope')
        : scope.globs.join('  ')
      const openFile = (file) => {
        try {
          const address = `dsh-resource://changes-review/session/${encodeSession(sessionId)}/${seq}/${state.data.turn}`
          tabInfo.tab.actions.openResource(address, { params: { index: file.index } })
          setOpenError('')
        } catch (error) {
          setOpenError(t('openFailed', { message: String(error?.message ?? error) }))
        }
      }

      const cardHead = unit === undefined ? null : h('div', { className: 'rg-card-head' },
        h('div', { className: 'rg-card-title' },
          h('span', null, unitTitle(unit, t)),
          h('span', { className: 'rg-counts' },
            h('span', { className: 'rg-add' }, t('added', { count: unit.added })),
            h('span', { className: 'rg-del' }, t('deleted', { count: unit.deleted })))),
        h('div', { className: 'rg-why' }, reasonText(unit, t)),
        units.length > 1 ? h('div', { className: 'rg-muted' }, t('unit', { index: selected + 1, count: units.length })) : null)

      const fileItems = unit === undefined ? [] : unit.files.map((file) => h('li', { key: file.path },
        h('button', {
          type: 'button',
          className: 'rg-file',
          title: file.display ?? file.path,
          onClick: () => openFile(file),
        },
        h('span', { className: 'rg-path' }, file.display ?? file.path),
        h('span', { className: 'rg-counts' },
          h('span', { className: 'rg-add' }, t('added', { count: file.added })),
          h('span', { className: 'rg-del' }, t('deleted', { count: file.deleted }))))))

      const card = unit === undefined ? null : h('div', { className: 'rg-card' },
        cardHead,
        h('ul', { className: 'rg-files' }, fileItems))

      const chips = units.length > 1 ? h('div', { className: 'rg-units' },
        units.map((entry, index) => h('button', {
          key: entry.key,
          type: 'button',
          className: 'rg-chip',
          'aria-pressed': index === selected,
          'aria-label': t('ariaUnit', { index: index + 1 }),
          onClick: () => setSelected(index),
        }, unitTitle(entry, t)))) : null

      const statusNode = state.status === 'loading' ? h('div', { className: 'rg-state' }, t('loading'))
        : state.status === 'missing' ? h('div', { className: 'rg-state rg-state-left' },
          h('div', { className: 'rg-state-title' }, t('missing')),
          h('div', null, t('missingBody')))
          : state.status === 'error' ? h('div', { className: 'rg-state' },
            h('div', { className: 'rg-state-title' }, t('error', { message: state.error })),
            h('button', { type: 'button', className: 'rg-retry', onClick: () => setReload(value => value + 1) }, t('retry')))
            : null

      const summaryLine = state.data === null ? null : h('div', { className: 'rg-muted' },
        t('files', { count: state.data.files.length }), ' · ',
        h('span', { className: 'rg-add' }, t('added', { count: state.data.added })), ' ',
        h('span', { className: 'rg-del' }, t('deleted', { count: state.data.deleted })),
        state.data.mode === 'graph' ? ` · ${t('graphMode')}` : state.data.mode === 'directory' ? ` · ${t('directoryMode')}` : null)

      const decisionBlock = unitHints.length === 0 ? null : h('div', { className: 'rg-decisions' },
        h('div', { className: 'rg-section-title' }, t('decisionTitle')),
        unitHints.map(hint => h('div', { className: 'rg-decision', key: `${hint.decisionId}:${hint.file}` },
          h('div', { className: 'rg-decision-text' }, hint.text),
          h('div', { className: 'rg-muted' }, `${hint.decisionId} · ${hint.source}`))),
        h('div', { className: 'rg-muted' }, t('decisionSuggest')))

      const nav = unit === undefined ? null : h('div', { className: 'rg-nav' },
        h('button', { type: 'button', disabled: selected === 0, onClick: () => setSelected(value => Math.max(0, value - 1)) }, t('previous')),
        h('button', { type: 'button', disabled: selected >= units.length - 1, onClick: () => setSelected(value => Math.min(units.length - 1, value + 1)) }, t('next')))

      return h('div', { className: 'rg-root', 'data-review-gate': '' },
        h('style', null, CSS),
        h('div', { className: 'rg-head' },
          h('div', { className: 'rg-title-row' },
            h('div', { className: 'rg-title' }, t('title')),
            h('div', { className: 'rg-muted' }, t('turn', { turn: state.data?.turn ?? changes.turn }))),
          h('div', { className: 'rg-muted rg-scope' }, t('scope', { scope: scopeText }))),
        h('div', { className: 'rg-body', ref: bodyRef },
          statusNode,
          summaryLine,
          chips,
          card,
          decisionBlock,
          nav,
          openError === '' ? null : h('div', { className: 'rg-error' }, openError),
          shouldShowOpenHint(state.status) ? h('div', { className: 'rg-hint' }, t('openHint')) : null))
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'review-gate: dictionaries')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          priority: 'extension',
          title: () => t('title'),
          guide: [{
            id: 'review-gate',
            order: 60,
            title: () => t('guideTitle'),
            description: () => t('guideDescription'),
          }],
        }), 'review-gate: tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          locale: NS,
        }, ReviewGateTab)), 'review-gate: tab body')
      },
      __test: { buildUnits, isEntry, entryPatternRegex, translate, ReviewGateTab, shouldShowOpenHint },
    }
  },
})
