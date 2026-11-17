# dsh-review-gate 技术方案

| 项目 | 内容 |
|---|---|
| 版本 | v0.2（与《需求分析报告》v0.2 配套） |
| 基线 | DeepSeek Harness `0.2.2-rc.3`（Desktop profile） |
| 形态 | DSH 插件包（Host 半 + Web Client 半），可本地安装、npm 发布、GitHub 分发 |
| 关键技术赌注 | 拦截点用 `tools/pre-execute`，不用自建 diff 渲染，不新增 session 事件类型 |

---

## 1. 设计原则

| 原则 | 落实方式 |
|---|---|
| **确定性优先** | 所有阻断/询问都来自可枚举规则；不调用 LLM 做边界判断 |
| **不重复造轮子** | diff 数据取 `workspace/changes`，diff 渲染跳转 `changes-review` 页签 |
| **可解释** | 每次决策产生 `ruleId + path + scope + 原因`，机器可读、人类可读各一份 |
| **故障放行、边界 fail-closed 可配** | 插件异常 → 放行 + 告警；**边界策略**不可用（审批被关）→ 按配置降级 |
| **最小惊讶** | 未声明范围 = 不拦截（只审计），避免"装上就处处弹窗" |
| **可逆** | 一切注册走 `ctx.effect`，卸载即净 |

---

## 2. 契约基线（已核验）

| 能力 | 契约 | 关键限制 | 证据 |
|---|---|---|---|
| 写前决策 | `tools/pre-execute(exec, next)`，`exec = {callId, name, arguments, agent?, signal}` | 不能改写参数；无内建超时，需自观察 `signal` | `dsh-tools/src/events.ts:18`、`contracts.ts:175-225` |
| 决策联合 | `allow \| deny{reason,info?} \| cancel \| ask{reason?,displayReason?}` | `displayReason` 是 `{en, [locale]}` 映射 | `contracts.ts:375-379` |
| ask 落地 | 管道调 `ctx.approval.request()`，仅 `allowed-once` 放行 | 请求**不带工具参数**；要求 turn 已打开；无审批服务 → fail-closed | `pipeline.ts:444-464`、`dsh-user-approval/README.md:28,53,166-168` |
| 审批 UI | `ApprovalPanel` 用 `displayReason` 作标题 | 卡片 props 仅 `requestKey/title/callId/canAnswer/onAllow/onReject` | `dsh-client-ui-approval/src/client/ApprovalPanel.tsx:11-14` |
| 单调守卫 | `ctx.tools.guard(fn)`，同步返回拒绝原因 | 只能 deny，不能 ask/allow；在 pre-execute 之后 | `dsh-tools/README.md:92`、`contracts.ts:402-418` |
| fs 意图门 | `fs/write-intent` / `fs/edit-intent` / `fs/delete-intent`（waterfall）+ 抛 `FsError` 拒绝 | 只能 deny；只有解析后的 `target`，**无工具参数** | `dsh-fs/src/index.ts:58-94`、`dsh-fs-observation-policy/src/index.ts:78-97` |
| 变更数据 | `workspace/changes` 事件（仅 `{turn}`）+ `ctx.workspaceChanges.summary()/diff()` | 仅 Host 进程内；子会话不记录；shell 写入在快照覆盖外会缺失；插件自 0.3.4 起把成功响应的元数据快照落盘，重启后以 `stale:true` 返回 | `dsh-workspace-changes/README.md:12,44,48` |
| diff 渲染 | `dsh-resource://changes-review/session/<sid>/<seq>/<turn>`，`openResource(addr,{params:{index}})` | 内部地址，需版本适配 | `ui-deliverables/src/changes.ts:143-146`、`review-definition.ts:38-49` |
| 命令 | `ctx.commands.register()`；`command/run` 落 `{commandId,name,args?,source}` | 命令结果不进模型上下文 | `dsh-commands/src/index.ts:373-378` |
| 会话投影 | `ctx.sessionProjections.register({key,stateSchema,init,apply,stateVersion,wire?})` | `apply` 必须纯同步 | `dsh-session-projection/src/index.ts:83-133` |
| 侧栏页签 | `ctx.sidebarRightTabs.register({id,kind,patterns?,title,...})` + `sidebar.right.pane.tab` | 页签体需自带 React 组件 | `ui-sidebar-right/src/client/tab-registry.ts:94-120` |
| 打包 | `package.json` + `dsh.bundle.patch` + `dsh.client` + `exports["./client"]`；浏览器产物是 lazy-CJS factory | 不能直接交 ESM | `dsh-doc/references/host-plugin.md`、`ui-plugin.md:9` |

---

## 3. 总体架构

```mermaid
flowchart LR
  subgraph Host[Host 进程]
    A[tools/pre-execute<br/>拦截管线] --> S[ScopeResolver<br/>会话投影]
    A --> R[RuleEngine<br/>删除行规则]
    A --> D[Decision<br/>合成/审批降级]
    D --> AP[ctx.approval]
    A --> AU[(Audit JSONL)]
    F[fs/*-intent 安全网] --> D
    G[ctx.tools.guard<br/>硬边界] --> A
    A --> P[ReviewOrchestrator<br/>P1]
  end
  subgraph Client[Web Client]
    T[侧栏页签<br/>审查顺序] --> P
    T --> V[changes-review 页签<br/>复用内置 diff]
    T --> Q[审批弹窗<br/>内置 ApprovalPanel]
  end
  S -. wire.view .-> T
```

### 3.1 一次写入的时序

```
Agent 调用 write(file_path, content)
  └─ tools/pre-execute
       1. 工具适配：工具名 → 参数提取器（paths / deletions / 操作类型）
       2. 范围解析：exec.agent.session → scope projection → glob 匹配
       3. 规则扫描：仅对"被删除的行"跑规则集
       4. 决策合成：硬边界 > 规则 block > 范围/规则 ask > allow
       5. 审计入队（异步、不阻塞返回）
       6. allow → return next()；ask/deny → 直接返回决策
  └─ (仅未映射工具) fs/*-intent 安全网：解析后目标再判一次
  └─ ctx.tools.guard：受保护路径的同步硬拒绝（可配置）
```

---

## 4. 拦截管线设计

### 4.1 工具适配器（Tool Adapter）

不同文件工具的参数字段不同，必须显式映射，未知工具走安全网而不是猜。

| 工具 | 路径字段 | 删除内容来源 |
|---|---|---|
| `write` | `file_path` | 读旧文件 → 与 `content` 做行差集（有上限） |
| `edit` | `file_path` | `old_string`（即被替换掉的内容） |
| `str_replace_editor` | `path` | `old_str` / `file_text`（`create` 无删除） |
| `apply_patch` 系 | 补丁文本 | 解析 `-` 开头的行（P2） |
| 未知工具 | — | 不做删除检测；仅 fs 安全网做路径判定 |

```ts
interface ToolAdapter {
  readonly name: string
  /** 返回本次调用会触达的路径（已相对化，未解析符号链接） */
  paths(args: unknown, cwd: string): string[]
  /** 只返回"将被删除"的行；无法确定时返回 undefined（触发降级） */
  deletions?(args: unknown, readFile: ReadBounded): Promise<DeletedLine[] | undefined>
  /** 该工具是否可能创建新文件 */
  mayCreate(args: unknown): boolean
}
```

**write 的删除检测**是有成本的，按预算裁剪：

```ts
async function deletionsOfWrite(args, read) {
  const before = await read(args.file_path, { maxBytes: 256 * 1024, timeoutMs: 15 })
  if (before === undefined) return undefined          // 读不到 → 降级
  const after = new Set(splitLines(args.content))
  return splitLines(before)
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(l => !after.has(l.text))                  // 多集差异近似
}
```

> 说明：这是"行出现与否"的近似差集，不做 LCS。对"是否删掉了某个敏感判断"这个目标足够；实现上零依赖、线性时间。

### 4.2 主钩子

```ts
ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
  if (!adapterFor(exec.name)) return next()            // 非文件工具：零开销放行

  const started = performance.now()
  try {
    const verdict = await decide(exec, { deadlineMs: config.limits.preExecuteMs })
    audit.append(exec, verdict, performance.now() - started)

    if (verdict.kind === 'deny') {
      return { kind: 'deny', reason: verdict.reason, info: verdict.info }
    }
    if (verdict.kind === 'ask') {
      return { kind: 'ask', reason: verdict.reason, displayReason: verdict.displayReason }
    }
    return next()
  } catch (error) {
    // 故障放行：边界能力自身的 bug 不能中断会话
    audit.degraded(exec, error)
    return config.onInternalError === 'deny'
      ? { kind: 'deny', reason: '[review-gate] internal error, denied by config' }
      : next()
  }
}))
```

要点：

- **必须 `return next()`** 放行，不能返回 `{kind:'allow'}`；否则会截断后续插件的决策（waterfall 语义）。
- 决策在 `catch` 中按配置降级；默认放行并记 `degraded`。
- 监听器注册为全局（不挂 `agent.ctx`），因此**子 Agent 的工具调用同样被覆盖**；这一点有意为之。

### 4.3 fs 安全网（只覆盖未映射工具）

`fs/*-intent` 在工具解析出真实目标之后触发，能覆盖将来新增的文件工具，但**只能 deny、且没有工具参数**。若对已映射工具也生效，会出现"审批里点了允许，随后被 fs 门再次拒绝"的矛盾。因此：

```ts
ctx.effect(() => ctx.on('fs/write-intent', (target, actor, next) => {
  if (isMappedTool(actor)) return next()        // 主钩子已判过，避免二次决策
  if (!isProtectedAndInScope(target.displayPath, target.targetKey)) {
    const error = new Error(`[review-gate] ...`)
    error.name = 'ReviewGateError'
    error.code = 'REVIEW_GATE_PROTECTED'
    throw error
  }
  return next()
}, { prepend: true }))
```

要点：

- 用 `{ prepend: true }` 抢在内置 `fs-observation-policy` 前面，否则单槽 waterfall 被它占满，后注册的监听器永远不执行。
- 同时检查 `displayPath` 与后端 `targetKey`（fs-local 是 realpath），避免符号链接逃逸。
- 抛出普通 `Error`（不 import `HarnessError`，保持零依赖）；DSH 的工具结果因此没有结构化 `info.code`，但文本带 `[review-gate]`，稳定 code 在审计行里。

### 4.4 同步硬边界（guard）

受保护路径（如 `.git/**`、`*.pem`、CI 配置）用 `ctx.tools.guard()` 做最后一道同步拒绝，确保**任何后注册的监听器都无法把它翻成允许**：

```ts
ctx.effect(() => ctx.tools.guard(exec => {
  for (const p of adapterFor(exec.name)?.paths(exec.arguments, cwdOf(exec)) ?? []) {
    if (isProtected(p)) return { reason: `[review-gate] protected path: ${p}`, info: { name: 'ReviewGateError', code: 'REVIEW_GATE_PROTECTED' } }
  }
  return undefined
}))
```

---

## 5. 范围模型

### 5.1 声明来源与优先级

| 优先级 | 来源 | 持久性 | 说明 |
|---|---|---|---|
| 1 | `/review-scope <glob...>` | **durable**（`command/run` 入会话日志） | 唯一一等公民；`clear` 清除 |
| 2 | 插件配置 `scope.default` | 配置层 | 团队统一默认范围 |
| 3 | 首条用户指令解析 | — | **默认关闭**，避免不可审计的隐式范围 |
| 4 | 未声明 | — | 放行 + 审计 `unscoped=true` |

### 5.2 投影（唯一的范围状态源）

```ts
ctx.sessionProjections.register({
  key: 'review-gate/scope',
  stateVersion: 1,
  stateSchema: z.object({
    globs: z.array(z.string()),
    declaredAtSeq: z.number().optional(),
    source: z.union([z.const('command'), z.const('config'), z.const('none')]),
  }),
  init: () => ({ globs: config.scope.default ?? [], source: config.scope.default ? 'config' : 'none' }),
  apply(state, event) {
    if (event.type !== 'command/run') return state
    if (event.data.name !== 'review-scope') return state
    const globs = parseScope(event.data.args ?? '')
    return { globs, declaredAtSeq: event.seq, source: 'command' }
  },
  wire: { viewSchema: z.object({ globs: z.array(z.string()), source: z.string() }), view: s => s },
})
```

为什么用投影而不是插件私有存储：范围状态**必须**能从会话日志重建（刷新、恢复、fork 一致），而 `command/run` 恰好是官方保证 durable 的既有事件。

### 5.3 glob 语义

| 语法 | 含义 | 示例 |
|---|---|---|
| `*` | 单段内任意字符 | `src/*.ts` |
| `**` | 任意层级（含零层） | `src/**/auth.ts` |
| `?` | 单字符 | `src/a?.ts` |
| `{a,b}` | 枚举 | `src/{auth,login}/**` |
| 前缀 `!` | 排除 | `!src/**/*.test.ts` |

归一化规则：`\` → `/`；相对路径以会话 cwd 为基准；折叠 `..`；Windows 默认大小写不敏感（可配）；符号链接在声明时 `realpath` 存一份别名，运行时优先词法匹配、必要时 realpath 复核。

### 5.4 `/review-scope` 命令

```ts
ctx.commands.register({
  name: 'review-scope',
  description: '声明本轮允许修改的路径范围',
  input: { hint: 'src/auth/**  !src/**/*.test.ts' },
  handler: ({ rawInput }) => {
    const globs = parseScope(rawInput)
    return globs.length === 0 && rawInput.trim() !== 'clear'
      ? { kind: 'error', text: '用法：/review-scope <glob...> | /review-scope clear' }
      : { kind: 'success', text: `范围已更新（${globs.length} 条）：${globs.join('  ')}` }
  },
})
```

命令结果是 UI 侧回显（不进模型上下文），正好承担"轻量卡片"的角色。

---

## 6. 敏感删除规则引擎

### 6.1 规则结构

```yaml
rules:
  - id: RG-AUTH-001
    title: 鉴权检查删除
    severity: ask            # ask | block
    appliesTo: [edit, write, str_replace_editor]
    match: any               # any | all
    patterns:
      - hasPermission\s*\(
      - isAuthori[sz]ed\s*\(
      - requireRole\s*\(
      - checkAuth(entication)?\s*\(
    ignorePaths: ['**/*.test.*', '**/fixtures/**']
  - id: RG-GUARD-002
    title: 守卫语句删除
    severity: ask
    patterns:
      - \bthrow\s+new\s+(Unauthorized|Forbidden|Permission)
      - \bif\s*\(\s*!
      - \breturn\s+(res\.)?(status\(401\)|status\(403\))
  - id: RG-VALID-003
    title: 输入校验删除
    severity: ask
    patterns:
      - \b(validate|sanitize|escape|assert)\w*\s*\(
```

### 6.2 匹配流程

1. 只对**删除行**匹配（新增行不触发），跳过空行、纯注释行。
2. 逐行跑规则正则，命中即记录 `{ruleId, lineNo, snippetHash}`。
3. 路径命中 `ignorePaths` → 跳过。
4. 行内 `review-gate-ignore <ruleId>` → 该行跳过；文件头 `review-gate-ignore` → 整个文件跳过。
5. 同一文件内同规则只报一次，附带所有行号。

**隐私**：审计与 UI 只显示规则 ID、行号、`snippetHash`（sha256 前 8 位），不落原文。

### 6.3 误报控制

| 手段 | 说明 |
|---|---|
| 默认 `ask` 而非 `block` | 让用户一眼否决，不中断 |
| 规则可单条关闭 | `rules.disabled: [RG-VALID-003]` |
| 路径白名单 | 测试、fixture、生成代码目录 |
| 只匹配删除行 | 避免"新增鉴权代码"反而被拦 |
| 规则集版本化 | 每次发布带 `rulesetVersion`，审计可回溯 |

---

## 7. 决策合成与降级

### 7.1 决策矩阵

| 情况 | 审批可用 | 审批不可用（`never` / 无服务） |
|---|---|---|
| 受保护路径 | `deny` | `deny` |
| 越界 + `scope.enforce=true` | `ask`（默认）/ `deny`（`strict`） | 按 `onApprovalUnavailable`（默认 `deny`） |
| 命中 `severity: block` 规则 | `deny` | `deny` |
| 命中 `severity: ask` 规则 | `ask` | 按 `onApprovalUnavailable` |
| 范围内、无命中 | `allow` | `allow` |

优先级：`deny(protected)` > `deny(rule)` > `ask(scope)` > `ask(rule)` > `allow`。
多个 ask 合并为一次审批，`displayReason` 列出全部原因。

### 7.2 文案策略

审批请求不携带参数，因此**所有关键信息都必须进文本**：

```ts
const reason = `[review-gate] tool=write callId=... path=src/utils/helper.ts scope=src/auth/**`
const displayReason = {
  en: 'Out-of-scope write: src/utils/helper.ts (scope: src/auth/**)',
  zh: '越界写入：src/utils/helper.ts（范围：src/auth/**）',
}
```

- `displayReason` 是审批卡的**标题**，内置 CSS 不保留换行；因此用单行、分隔符（`；` / `; `）表达，不写成多行。
- locale 键是 `en` / `zh`（Client locale 的 `localeKey` 会小写化；不是 `zh-CN`）。未提供的语言回落到 `en`。
- `deny` 的 `reason` 同样带 `[review-gate]` 前缀与规则 ID，便于模型自我纠正、便于日志检索。
- `info.code` 取值：`REVIEW_GATE_SCOPE_DENIED` / `REVIEW_GATE_RULE_DENIED` / `REVIEW_GATE_PROTECTED` / `REVIEW_GATE_INTERNAL`。

### 7.3 审批可用性探测（M0 关闭项）

```ts
function approvalAvailability(ctx, agent): 'available' | 'never' | 'absent' {
  if (!ctx.get('approval')) return 'absent'
  // M0 待验证：是否存在只读 policy 查询 API；否则用 try/catch 探测会误触发审计
  return policyOf(ctx, agent) === 'never' ? 'never' : 'available'
}
```

**若 M0 证实没有只读查询 API**：退化为"配置显式声明 `approvalPreset: ask | never`"，由用户对齐；同时在 README 写明该约束。

---

## 8. 审计

### 8.1 记录结构（每决策一行 JSON）

```json
{
  "v": 1,
  "ts": "2026-11-17T13:05:22.418Z",
  "sessionId": "session-…",
  "turn": 12,
  "tool": "write",
  "callId": "call-…",
  "decision": "ask",
  "reason": "scope-violation",
  "path": "src/utils/helper.ts",
  "scope": ["src/auth/**"],
  "rules": ["RG-SCOPE-001"],
  "snippetHash": "9f2c1a4e",
  "approval": "rejected",
  "durationMs": 7.3,
  "degraded": false,
  "dshVersion": "0.2.2-rc.3",
  "pluginVersion": "0.3.0"
}
```

### 8.2 实现约束

- **不入库内容**：路径、规则 ID、哈希；不写 `old_string`、文件正文、diff。
- **不阻塞**：`audit.append` 只入内存队列，后台串行写；队列上限 1000，溢出丢弃并计数。
- **写失败**：告警一次后静默；不影响工具调用。
- **轮转**：按日 `audit-YYYY-MM-DD.jsonl`，单文件上限 8MB；路径默认 `$DSH_HOME/review-gate/audit/`，可配。
- **合规**：`audit.enabled=false` 时完全关闭；README 说明这是本地文件、不上传。

---

## 9. P1 审查编排

### 9.0 v0.2.0 实际实现

- **数据路径 A 落地**：Host 注册两个 client-visible projection：
  - `review-gate/changes`：折叠最近的 `workspace/changes`，输出 `{seq,turn}`；
  - `review-gate/meta`：输出配置的 `maxUnits` / `entryPatterns`；
  - `review-gate/scope` 同时改为 client-visible（顶部显示当前范围）。
- **Client tab 类型**：`ctx.sidebarRightTabs.register({id:'@ailunsin/dsh-review-gate', kind:'review-gate', priority:'extension', guide:[…]})`；tab body 注册在 `sidebar.right.pane.tab` 的同一 key 下，使用 `useProjection`、`useTabInfo` 标准 props。
- **取数**：Client 用 `useProjection('review-gate/changes')` 得到 seq，`fetch('api/changes.summary?sessionId&seq')`（内置认证路由，方法 A；document-relative，与内置 deliverables 一致），纯前端 `buildUnits` 分组。
- **跳转**：点击文件用 `tab.actions.openResource('dsh-resource://changes-review/session/<sid>/<seq>/<turn>', { params: { index } })` 打开内置 `changes-review`，不重绘 diff。
- **验证**：Client bundle 已安装到当前 Desktop profile；Client Inspect 的 `sidebar.right.pane.tab` occupants 出现 `@ailunsin/dsh-review-gate`（active）。视觉/交互已由 B8/B12 实机验收（2026-11-18，见 `docs/verification-0.3.1.md`）。
- **偏差**：未注册 Host 自有路由（方案 B），因此不需要额外鉴权；`review` 配置通过 projection 下发，不在 Client 重复读取 Host 配置。

### 9.1 数据获取（两条路径，先 A 后 B）

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **A（P1 采用）** | Client 侧读取 `workspace/changes` 事件，按 seq 请求内置 `/api/changes.summary`，纯前端分组 | 零 Host 路由、零鉴权代码 | 依赖内置路由（版本适配） |
| B（P2 增强） | Host 注册自有路由，调 `ctx.workspaceChanges.summary/diff`，并读文件算导入图 | 数据完整、可做符号图 | 需处理会话鉴权与路由生命周期 |

A 的降级链：`summary` 拉取失败 → 显示"本轮改动"文件清单（来自工具卡）→ 再失败 → 仅显示入口链接。

### 9.2 分组算法（确定性、可解释）

```ts
function buildUnits(files: ChangedFile[], cfg: ReviewConfig): ReviewUnit[] {
  // 1) 入口种子
  const seeds = files.filter(f => cfg.entryPatterns.some(p => p.test(f.path)))
  // 2) 归属：有导入图时按"从入口可达的弱连通分量"，否则按目录
  const unitKey = (f: ChangedFile) =>
    importGraph ? reachableComponent(f, seeds) : topTwoSegments(f.path)
  // 3) 聚合 + 风险分（risk 的输入来自本轮 gate 决策缓存与本轮改动统计）
  const units = groupBy(files, unitKey).map(([key, fs]) => ({
    key,
    files: fs,
    additions: sum(fs, 'added'),
    deletions: sum(fs, 'deleted'),
    entryScore: centralityOf(key, importGraph),   // 无图时按入口文件名/目录深度估算
    risk: 0.4 * normSize(fs) + 0.35 * sensitiveHits(fs) + 0.25 * outOfScopeRatio(fs),
    reasons: explain(key, fs, seeds, importGraph),
  }))
  // 4) 排序：入口中心性 → 风险 → 路径；全部确定性
  return units.sort((a, b) =>
    b.entryScore - a.entryScore || b.risk - a.risk || a.key.localeCompare(b.key))
}
```

- **P1 实际**：`topTwoSegments` + 入口文件名启发式（`index|main|app|server|cli|__init__|mod`）；入口单元优先，其次按改动量、路径排序。入口 pattern 仅支持 `*`/`**`/`?`，Host 校验拒绝 `{a,b}`、`[]`、`!`，避免与 Client 匹配器不一致。不做敏感命中/越界风险的混排（范围在页签顶部展示）。
- **有导入图**（P2）：对改动文件按 64KB 上限读取，正则抽取 `import/from/require`，相对说明符解析后建图。
- `reasons` 实际产出："包含入口文件 X"、"改动量 +A/−D"、"二进制/超大文件"、"其余 N 个文件合并"。
- 稳定性：输入按 path 排序后再分组，输出对同一输入恒定。

### 9.3 P2 实际（v0.3.0）

- **导入图**：Host 路由 `GET /api/review-gate.units?sessionId&seq` 经 `ctx.connection.fetch.register` 注册（认证 fence），读取本轮改动文件（≤40 个、每个 ≤64KB），解析相对 JS/TS `import/export/require` 与 Python `from .` import，只在改动文件集合内建无向边；按入口可达弱连通分量分组，否则回退目录分组。Client 先取该路由，路由/FS 不可用时回退 P1 的 `api/changes.summary` + 目录分组。
- **决策提示**：从 `review.decisionSources`（默认 CLAUDE.md/AGENTS.md/docs/adr/docs/decisions/docs/decisions.md，≤20 文件）、以及改动文件内 `@decision` 注释抽取；只有同时具备显式 `Applies to:` 范围（或注释自身的文件）与反引号标识符时才可标注。对命中文件取 `workspaceChanges.diff`（≤8 文件），仅当被删行包含该标识符时产生 `hints`；标注为建议性，不阻断。
- **Client**：route 返回 `units`/`hints` 时直接渲染；顶部显示 `import graph`/`directory grouping`；决策提示按单元文件过滤展示；无 route 时静默回退。
- **边界**：不跟包名 import、不做跨包图；不做 LLM 语义判断；决策文本可能很长，响应只带首个命中标识符的决策，不返回代码正文。
- **测试**：`review-units`（导入/TS .js→.ts/Python/合并/目录回退）、`decisions`（ADR/指令/注释/删除行）、`review-route`（认证 handler 形状、hints、降级）与 plugin route 注册。

### 9.3.1 重启后的快照（v0.3.4）

- **问题**：`workspaceChanges.summary()` 只活在 Host 进程内，DSH 重启后持久化的 `review-gate/changes` 投影仍指向旧 `seq`，路由与 `/api/changes.summary` 都返回 404。0.3.3 的处理是回到空态。
- **做法**：每次路由成功返回改动清单后，把 `turn/total/added/deleted/files[{path,display,added,deleted,binary?,oversized?}]` 以原子写落盘到 `review.snapshot.dir`（默认 `$DSH_HOME/review-gate/snapshots`，文件名 `<sha256(sessionId) 前 16 位>-<seq 补零>.json`，保留最近 20 份）。404 时读回快照，用目录分组重建 `units`，响应带 `stale:true` 与 `capturedAt`，`hints` 为空，并附 `x-review-gate-snapshot: 1`。
- **不存什么**：不存文件正文、diff、决策提示文本、`cwd`；只存渲染所需的路径与计数，保证「不存正文」约束不被快照破坏。
- **Client**：`stale` 时显示「Host 已重启，显示 {time} 的上一轮快照」提示，文件行改为不可点击，隐藏「点击文件…」提示；正常轮次行为不变。
- **代价**：只在打开过页签、成功取到一次清单后才有快照；快照不反映之后的工作区变化，因此必须显式标注为快照且禁止打开文件。
- **关闭**：`review.snapshot.enabled: false` 恢复 0.3.3 的空态行为。

### 9.4 侧栏页签（实际）

| 区块 | 内容 |
|---|---|
| 范围状态 | 顶部显示当前 globs、来源（命令/配置/未声明） |
| 本轮审查单元 | 单元 chips + 当前单元卡：标题、`+/-`、`reasons`、上/下一组 |
| 单元内文件 | 点击 → `tab.actions.openResource('dsh-resource://changes-review/session/<sid>/<seq>/<turn>', { params: { index } })` |
| 状态 | 空（本轮无改动）、加载、404（Host 不再提供）、错误 + 重试 |

UI 约束：只用 `--dsw-alias-*` 主题 token；文案走 client locale；tab 类型 `id` 为包名、`kind: 'review-gate'`，guide 入口 title/description 均本地化。

---

## 10. 预测 diff（已砍，不实现）

F-13/F-14 已于 2026-11-17 砍掉（见 `docs/decisions.md`）。本节仅保留为历史预算记录，不作为实现任务：

| 步骤 | 预算 |
|---|---|
| 读旧文件（≤256KB） | 10ms |
| 内存内应用替换（`old_string→new_string` / `write` 覆盖） | 5ms |
| hunks 生成（3 行上下文，复用与内置一致的算法参数） | 20ms |
| 渲染进卡片 | 由 `dsh-diff-review` 负责 |

限制：`replace_all`、CRLF、编码、生成文件、并发修改都会让预览与落盘不一致。**结论：不做预测 diff，也不做确认式放行；审批文案里只留一行影响摘要。**

---

## 11. 配置 Schema（实现说明）

P0 不引入 `@deepseek-ai/schemastery` 依赖，也不导出 `Config`：配置由 `src/config.js` 手写校验（未知键/类型/枚举/glob 非法均在激活时抛错）。这与内置包用 schemastery 的写法不同，但运行时由 Loader 直接传入普通对象，行为等价且少一个依赖。

实际字段（与 README 一致）：

```text
enabled, locale,
scope { enforce, strict, default[], caseSensitive },
rules { enabled, disabled[], custom[], ignorePaths[] },
protectedPaths[],
onApprovalUnavailable, onInternalError,
limits { preExecuteMs, readFileBytes, readFileMs, ruleMs, auditQueue },
audit { enabled, dir, maxFileBytes },
review { maxUnits, entryPatterns[], importGraph, decisionSources[] }
```

`custom[]` 条目：`id, title, severity(ask|block), appliesTo[], patterns[], ignorePaths[]`。同 ID 覆盖默认规则；`rules.disabled` 关闭规则。

`review` 从 0.3.0 起实际生效：`importGraph` 控制 Host 导入图路由；`decisionSources` 是工作区相对路径（文件或目录），空数组关闭决策提示；入口 pattern 仅支持 `*`/`**`/`?`。P0 的校验器曾拒绝这些未知键，现已实现，不存在“配置了但未启用”的静默状态。

patch 覆盖（整块替换，不深合并）：

```yaml
- id: review-gate
  name: '@ailunsin/dsh-review-gate'
  config:
    scope:
      default: ['src/**']
    onApprovalUnavailable: deny
```

---

## 12. 包结构（P0 实际）

```text
dsh-review-gate/
├─ package.json
├─ cordis.patch.yml
├─ src/
│  ├─ index.js              # Host 入口（ESM，apply(ctx, config)）
│  ├─ config.js             # 手写校验
│  ├─ glob.js               # 零依赖 glob
│  ├─ scope.js              # command 解析 + session projection
│  ├─ projections.js        # review-gate/changes / meta
│  ├─ review-units.js       # P2 导入图分组
│  ├─ decisions.js          # P2 ADR/指令/注释 + 矛盾提示
│  ├─ review-route.js       # P2 认证 /api/review-gate.units
│  ├─ commands.js
│  ├─ adapters.js
│  ├─ rules.js
│  ├─ decide.js             # 决策合成 + 审批可用性
│  ├─ audit.js              # JSONL 审计
│  ├─ interceptors.js       # pre-execute / fs 安全网 / guard / approval 回执
│  ├─ locale.js
│  └─ util.js
├─ client.js               # lazy-CJS Web 半：审查顺序页签
├─ locale/{en,zh}.json
├─ icon.svg
├─ docs/                    # 需求、技术方案、决策、M0、发布
├─ test/                    # node:test
├─ e2e/                     # 真实 DSH headless + fake LLM / fake fs tool
├─ scripts/                 # 语法检查、构建、冒烟、索引校验
├─ README.md
├─ SECURITY.md
├─ CHANGELOG.md
└─ LICENSE
```

```json
{
  "name": "@ailunsin/dsh-review-gate",
  "version": "0.3.0",
  "type": "module",
  "description": "Deterministic pre-write scope gate and review sequencing for DeepSeek Harness",
  "license": "MIT",
  "engines": { "dsh": "0.2.2-rc.3" },
  "exports": {
    ".": "./src/index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["src", "client.js", "cordis.patch.yml", "locale", "icon.svg", "docs", "README.md", "LICENSE", "SECURITY.md", "CHANGELOG.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": false, "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"] }
  }
}
```

> 无 scope 的 `dsh-review-gate` 已被无关项目占用，npm 发布名固定为 `@ailunsin/dsh-review-gate`；仓库短名与插件行 id 仍为 `review-gate`。P1 已加 `./client`、`dsh.client` 与侧栏审查顺序页签。

```yaml
# cordis.patch.yml
- insert:
    - id: review-gate
      name: '@ailunsin/dsh-review-gate'
      config:
        enabled: true
        scope:
          enforce: true
```

P1 的 `client.js` 按 lazy-CJS factory 编写（模板见 `dsh-doc`），已补 `./client` 导出、`dsh.client` 字段与 `client.js` 文件清单。实际注册如下（简化）：

```js
window.__ModuleLoader__.load({
  id: '@ailunsin/dsh-review-gate',
  factory(require) {
    const React = require('react')
    const NS = 'reviewGate'
    function ReviewTab() { /* 使用 useProjection / useTabInfo */ }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'review-gate: dictionaries')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: '@ailunsin/dsh-review-gate',
          kind: 'review-gate',
          priority: 'extension',
          title: () => t('title'),
          guide: [{ id: 'review-gate', order: 60, title: () => t('guideTitle'), description: () => t('guideDescription') }],
        }), 'review-gate: tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: '@ailunsin/dsh-review-gate',
          locale: NS,
        }, ReviewTab)), 'review-gate: tab body')
      },
    }
  },
})
```

> 注册形状取自内置 `ui-deliverables`（`src/client/index.ts:89`）与 `ui-plan`（`src/client/index.ts:65`）：`title` 用 `ctx.locale.bind(NS)` 返回的 `t`，页签体经 `ctx.slots.inject('sidebar.right.pane.tab', …)` 注册；两处都用 `ctx.effect` 包裹以保证卸载即净。

---

## 13. 可靠性、性能、安全

### 13.1 超时与降级

| 场景 | 行为 |
|---|---|
| pre-execute 计算超 `preExecuteMs` | 按 `onInternalError` 降级：默认 `next()` + `degraded=true`；配置 `deny` 时拒绝 |
| 读旧文件超时/超大 | 跳过删除检测（规则不产生命中记录；审计仍记录决策） |
| 规则正则灾难性回溯 | 规则编译期检查；运行时逐行匹配，单规则超 `limits.ruleMs` 终止该规则并告警 |
| 投影 `apply` 抛错 | 会话投影框架隔离；范围回退到配置默认值 |
| payload 结构不匹配 | 适配层校验 `callId/name/arguments`；不匹配 → 放行 + 告警（N-04） |

### 13.2 性能预算（单次 write，P95）

| 环节 | 预算 |
|---|---|
| 适配器 + 路径归一化 | 0.5ms |
| 范围匹配（≤16 glob） | 0.3ms |
| 删除行提取（read 256KB + 差集） | 12ms |
| 规则匹配（20 条 × 1000 行） | 4ms |
| 决策 + 文案 | 0.2ms |
| 审计入队 | 0.1ms |
| **合计** | **≈17ms** |

`edit` 无规则命中时零读文件；命中后为行号/header 复核读一次（≤256KB），P95 目标 < 3ms（无命中）/ < 20ms（命中）。非文件工具 < 0.5ms（一次 Set 查找）。

### 13.3 安全

| 威胁 | 缓解 |
|---|---|
| 路径穿越（`../../etc/passwd`） | 归一化 + 绝对化 + 工作目录前缀校验；越界路径直接 `deny` |
| 符号链接逃逸 | 声明时 realpath 别名；运行期对已存在文件复核 realpath |
| 大小写/短文件名绕过（Windows） | 默认大小写不敏感；路径比较用规范化形式 |
| 审计泄露源码 | 只存哈希与路径；`audit.enabled=false` 可关闭 |
| 拒绝服务（超大文件） | 读取上限 + 超时 + 降级 |
| 恶意规则 | 规则来自用户配置；编译期拒绝超长/嵌套正则 |

---

## 14. 测试策略（P0 实际）

| 层级 | 内容 | 工具 |
|---|---|---|
| 单元 | glob 匹配表、行差集、规则匹配、决策矩阵、文案格式、路径归一化、配置校验、审查单元分组、导入解析、决策提示、projection wire | `node:test`（`test/*.test.js`，142 项） |
| 集成 | 假 `ctx` 驱动 apply / pre-execute / fs 安全网 / guard / 卸载清理；审批桩覆盖 available/never/absent | `node:test` |
| 端到端 | 真实 DSH headless：never + fs 安全网（`e2e/run.mjs`）；ask→reject / ask→allow + approval 审计（`e2e/approval.mjs`） | 真实 profile |
| Client | Client Inspect 验证 tab body `@ailunsin/dsh-review-gate` 在 `sidebar.right.pane.tab` active；client.js 单测（工厂注册/分组） | 本机 Desktop profile |
| 性能 | 2,000 次范围内 write 决策，断言均值 < 10ms、P95 < 50ms | `node:test` |
| 回归 | 每次 DSH 升级跑 `npm test` + `npm run e2e` | 本机 / 未来 CI 手动 |

---

## 15. 发布与上架

### 15.1 GitHub

- 仓库：`AiLunSin/dsh-review-gate`，MIT，`main` + tag；发布产物由 `scripts/build-release.mjs` 生成，不提交 `dist`。
- 必备文件：`README.md`（定位、安装、配置、已知限制）、`LICENSE`、`SECURITY.md`、`icon.svg`、`locale/`、`CHANGELOG.md`。
- README 必须写清限制：不拦 shell、审批不带参数、删除检测是行级近似、未声明范围不拦截。

### 15.2 安装路径

| 路径 | 方式 | 适用 |
|---|---|---|
| 本地目录 | 插件管理器 `install_bundle` 的目标填绝对路径 | 开发调试 |
| Git | `install_bundle` 支持 `github:owner/repo`、`git+https://…`、`https://host/owner/repo` | 尝鲜用户 |
| npm | `@ailunsin/dsh-review-gate@0.3.0` | 正式分发 |
| 市场索引 | 自建 `index.json`（HTTPS）→ 用户添加索引 URL | 曝光 |

### 15.3 npm 与版本兼容

- `engines.dsh` 是**唯一**决定兼容性的字段（声明后 `peerDependencies` 被忽略），因此写**精确版本** `0.2.2-rc.3`；每次 DSH 发版后验证并同步升级。
- 若某次只改文档/规则集，可发 patch；涉及事件契约变更必须发 minor 并更新 `engines.dsh`。

### 15.4 市场索引

实际文件是仓库根 `index.json`，已用 DSH 0.2.2-rc.3 的官方 `parseMarketIndex` 校验通过。要点：

- `format: 1`；`title.en` 必填。
- `metadata.categories/labels/sortKeys` 是**声明对象**（`{ "<id>": { "title": { "en": … } } }`），不是字符串数组。
- `versions[].publishTimestamp` 是 **Unix 秒整数**，不是 ISO 字符串。
- 相对 icon 会按索引 URL 解析；本项目使用绝对 raw GitHub URL。
- 生成的 `versions[].source` 为 `{ "type": "npm" }`，`engines.dsh` 为精确版本。

校验命令：`node scripts/validate-market-index.mjs`（无 DSH 安装时只做本地结构检查并明确提示）。

### 15.5 CI

```yaml
# .github/workflows/ci.yml（实际）
- npm install --no-audit --no-fund
- npm run lint                 # node --check + JSON/manifest 检查
- npm test                     # node:test
- npm run build:release
- npm run smoke:install        # manifest + npm pack；有 DSH 时加临时 profile 安装
- npm run validate:index       # 无 DSH 时只做本地结构检查
```

真实 e2e（`npm run e2e`）不在 CI 默认跑：需要 DSH 安装与 Electron Node 运行时；在 DSH 升级时本机手动执行。

---

## 16. 里程碑与任务拆解

| 阶段 | 任务 | 人日 |
|---|---|---|
| M0 | approval 只读策略探测；fs intent 的 actor 能力；`displayReason` 多行/本地化渲染；相对路径 cwd 来源 | 5 |
| M1 | 适配器 + 范围投影 + 命令 | 4 |
| M1 | 规则引擎 + 默认规则集 + 白名单 | 4 |
| M1 | 决策合成 + 审批降级 + 文案 | 3 |
| M1 | 审计 + 降级 + 卸载清理 | 2 |
| M1 | 打包（package.json/patch/locale/icon）+ README | 3 |
| M1 | 测试与 E2E | 4 |
| M2 | 页签 UI + 分组/排序 + 跳转 | 10 |
| M2 | 数据降级链 + 版本适配 | 3 |
| M3 | 导入图 + 决策源（预测 diff 已砍） | 10 |

---

## 17. 架构决策记录（ADR）

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| ADR-1 | 不新增 session 事件类型，范围状态用 `command/run` + 投影 | 自建事件；`appendPluginRecord` | 官方明确插件不得追加新 type；后者仅限实验包，且升级可能丢 |
| ADR-2 | 不自定义审批 UI，信息写进 `displayReason` | 替换 `conversation.approval.detail` | 该座位已被内置占用（`shadows-shipped-ui`），替换风险高 |
| ADR-3 | 主门 `pre-execute` + 安全网 `fs/*-intent` + 硬边界 `guard` | 只用其一 | 主门能 ask 且有 agent；fs 门能覆盖未知工具；guard 防翻案 |
| ADR-4 | 不做 diff 渲染与预测 diff | 自建 | 内置与生态已覆盖；重写只会增加维护面 |
| ADR-5 | 反静态存储：范围只从日志派生 | `ctx.storage` 存范围 | 日志是唯一真源；存私有 KV 会在 fork/恢复时不一致 |

---

## 18. M0 待验证清单（结果）

| # | 问题 | 结果 | 退路是否触发 |
|---|---|---|---|
| 1 | 是否存在只读审批策略查询 | `overrideOf(session)` + `config.policy` 两段读取；无单一公开 effective getter | 部分：用配置默认兜底 |
| 2 | `fs/*-intent` 的 `actor` 是否含 agent/session | 是（`ToolExecution`） | 否 |
| 3 | `displayReason` 是否多行显示、locale 如何解析 | 单行标题；键为 `en`/`zh` | 是：压缩成单行 |
| 4 | `file_path` 相对路径的 cwd 来源 | `workingDirectory.ensure`（工具）/`get`（钩子）+ header 兜底 | 否 |
| 5 | Client 能否请求 `/api/changes.summary` | **已实现**：client.js 用 `useProjection('review-gate/changes')` 得 seq，`fetch('/api/changes.summary?...')`；与内置 deliverables 同路由（源码核验） | 未走 Host 路由 |
| 6 | 侧栏页签 `kind:'session'` 实例语义 | **已实现并验证**：`sidebar.right.pane.tab` 为 session-scope keyed slot；安装 0.2.0 后 Client Inspect occupants 含 `@ailunsin/dsh-review-gate`（active） | 无 |

完整证据与运行时结果见 [`docs/spike-m0.md`](spike-m0.md)。

---

## 19. 已知限制（README 已写明）

1. 只约束 `write`/`edit`/`apply_patch`/`str_replace_editor`；`bash` / `pwsh` / MCP 直接写文件不受控。`fs/*-intent` 安全网只覆盖主动经过该事件的文件工具；需要硬边界时配合沙箱模式。
2. 审批请求不携带参数，用户只能看到插件生成的单行 `displayReason`；范围内详情可在 P1 侧栏“审查顺序”页签查看。
3. `write` 的删除检测是行级近似，不保证与最终落盘逐行一致；读不到旧文件/超限时跳过删除检测。
4. 未声明范围时默认放行（只审计），这是刻意选择。
5. 审批服务存在但无 answerer（headless/无 UI）时，`ask` 由 DSH 管道 fail-closed 成拒绝；`onApprovalUnavailable: allow` 只覆盖"无服务 / 策略 never"。
6. 子 Agent 的写入会被拦，但 scope 取子会话自身，父会话范围不自动继承；P1 审查单元不含子会话（内置 `workspace/changes` 不记录）。
7. P1 审查顺序只显示当前会话最近一次 `workspace/changes`；无导入图（P2）；分组是目录/入口启发式，不把敏感规则或越界状态混入排序；依赖内置 `/api/changes.summary` 与 `changes-review` 页签，DSH 升级需回归。
8. P1 的 Client 视觉/交互（浅色/深色、窄栏、点击跳转）已由 B8/B12 实机验收（2026-11-18，见 `docs/verification-0.3.1.md`）；此前仅完成 Client Inspect 注册验证与 client.js 单测。
9. P2 决策提示只认可显式 `Applies to:` 范围 + 反引号标识符命中，属保守启发式；无结构化范围的 ADR 不会提示，可能漏报，不构成合规证明。导入图只解析改动文件之间的相对 import，不跟包名/跨包。
10. P2 Host 路由经 Connection 认证；无 Web/Connection 的 profile（如 headless）不注册，Client 回退 P1 目录分组。
