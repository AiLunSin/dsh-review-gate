# M0 技术验证报告（dsh-review-gate P0）

| 项目 | 内容 |
|---|---|
| 日期 | 2026-11-17 |
| 基线 | DeepSeek Harness `0.2.2-rc.3`（Desktop ASAR 内包源码） |
| 方法 | 读取已安装 ASAR 内 `@deepseek-ai/*` 源码与 README；真实 DSH headless 冒烟；单元/集成测试 |
| 结论 | **P0 GO + P1 注册验证**：6 项全部关闭；P1 侧栏 body 在 Desktop profile 中 active，视觉人工验收仍待做 |

---

## 1. 六项验证结论

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 是否存在只读审批策略查询 | **有，但分两段**：`approval.overrideOf(session)` 读会话覆盖；部署默认读 `approval.config.policy`。没有单一的公开 `effectivePolicy()`。 | `dsh-user-approval/src/index.ts:176-178`（`config` 为 public）、`:270-281`（`effectivePolicy` 私有，`overrideOf` 公开） |
| 2 | `fs/*-intent` 的 `actor` 是否含 agent/session | **含**。`actor` 就是 `ToolExecution`（有 `name`/`agent`/`callId`/`signal`）；内置观测策略用 `actor.agent.session` 做 owner。 | `dsh-tool-fs/src/write.ts:118-124`；`dsh-fs-observation-policy/src/index.ts:36-41` |
| 3 | `displayReason` 是否多行、locale 如何解析 | **不是多行**：它是审批卡标题，`div.headline` 无 `white-space: pre-line`，换行会折叠。locale 键是 `en`/`zh`（不是 `zh-CN`）。 | `dsh-client-ui-approval/src/client/ApprovalPanel.tsx:9-18`；`ApprovalCard.tsx:72-74`；`ApprovalPanel.module.css:41-46`；`dsh-client-locale/src/client/index.ts:128-130, 215-221` |
| 4 | `file_path` 相对路径的 cwd 来源 | **会话工作目录**：工具用 `workingDirectory.ensure(agent)`；`fs-local` 的 `displayPath` 解析为绝对路径。钩子里用 `workingDirectory.get(session)`（同步）/`session.header.cwd` 兜底。 | `dsh-tool-fs/src/session-cwd.ts:17-25`；`dsh-working-directory/src/index.ts:141-143, 154-175`；`dsh-fs-local/src/fsio.ts:162-168` |
| 5 | Client 能否请求 `/api/changes.summary`（P1） | **已实现**：client.js 用 `useProjection('review-gate/changes')` 取 seq 后 `fetch('/api/changes.summary?...')`；与内置 deliverables 同一认证路由（源码核验）。 | `dsh-client-ui-deliverables/src/changes.ts:111-146`、`present-open.ts:26-29`；`client.js` 取数逻辑 |
| 6 | 侧栏页签 `kind:'session'` 实例语义（P1） | **已实现并验证**：`sidebar.right.pane.tab` 是 session-scope keyed slot；0.2.0 安装后 Client Inspect 的 occupants 含 `@ailunsin/dsh-review-gate`（active）。 | `dsh-client-ui-sidebar-right/src/client/index.ts:200-318`、`tab-registry.ts:94-120`；活体 Client Inspect |

**架构影响：** 第 1–4 项决定 P0 的拦截与降级设计；第 5–6 项已随 P1 关闭。P1 采用方案 A（Client 请求内置 summary），未新增 Host 路由。

### P1 Client 注册证据

- 安装 `@ailunsin/dsh-review-gate@0.2.0` 到本机 Desktop profile，`install_bundle` 返回 `application: applied`。
- `cordis_inspect_query`（Client）`Slots.listSubTree(root='sidebar.right.pane.tab')` 的 `occupants` 出现
  `{key:'@ailunsin/dsh-review-gate', active:true}`。
- Client bundle 在页面内注册了 `sidebarRightTabs` 类型（`kind:'review-gate'`）与 body；tab 类型注册失败会在 body 之前抛错，因此 active body 同时证明类型注册成功。
- 视觉渲染、窄栏/浅深色与“点击文件跳转”的人工验收未完成。

---

## 2. 运行时证据（真实 DSH headless）

命令：`npm run e2e`（`e2e/run.mjs`）。临时 `DSH_HOME` + `headless` profile + 脚本化 LLM + 测试专用插件（fake LLM / 未映射 fs 工具 / 命令触发器），真实走完一次 turn：

0. 新 Agent 创建时，测试插件通过真实命令注册表执行 `/review-scope src/auth/**`（不依赖 UI）
1. `write src/utils/helper.ts`（越界）→ 拒绝
2. `write src/auth/login.ts`（范围内）→ 成功
3. `read src/auth/login.ts` → 成功
4. `edit` 删除 `hasPermission` 行 → 拒绝
5. `fake_fs_write src/utils/mcp.ts`（未映射工具，走 `fs/write-intent`）→ 拒绝
6. 最终文本

结果（2026-11-17 本机）：

```text
e2e: PASS pre-execute deny/allow + fs safety net + audit + no out-of-scope file
```

关键观察：

- 会话日志出现真实 `command/run`（`name=review-scope`，`args=src/auth/**`）；3 条 pre-execute 审计的 `scopeSource` 都是 `command`，证明 session projection 从日志重建了范围，而不是退回配置默认值。
- 第 1/4 个拒绝带 `REVIEW_GATE_APPROVAL_UNAVAILABLE`：profile 已将 `approval` 行配置为 `policy: never`，插件在 `tools/pre-execute` 里先判定策略、再按 `onApprovalUnavailable: deny` 拒绝，**没有**把 `ask` 交给 DSH 管道去撞 `never`。
- 第 5 个拒绝的模型侧文本为 `Error: [review-gate] 越界写入：src/utils/mcp.ts（已声明范围：src/auth/**） (fs-intent=write)`；审计行带 `code=REVIEW_GATE_SCOPE_DENIED`。普通 `Error` 不是 `HarnessError`，因此工具结果没有结构化 `info.code`，但文本与审计都带标记。
- 越界文件与 fs 安全网文件都未落盘；范围内文件已创建且被拒绝的 edit 未修改它。
- 审计目录 `$DSH_HOME/review-gate/audit/audit-YYYY-MM-DD.jsonl` 有 3 条 pre-execute 决策 + 1 条 fs-intent 拒绝；不含 `hasPermission` 原文。

审批链路另跑 `e2e/approval.mjs`（policy `ask` + fake answerer）：越界写入 → `ask` → `rejected`；敏感删除 → `ask` → `allowed-once`。会话日志出现 2 组 `approval/asked`/`decided`（outcome `rejected`、`allowed-once`）；被允许的 edit 真实落盘（auth 行被删除），审计有 2 条 `type:"approval"` 与 3 条 decision（ask/allow/ask）。

局限：headless profile 默认 `fs-observation-policy` 为 `disabled: true`，所以真实 e2e 不覆盖“先读后写 + 版本守卫”的交互；这部分由单测和 Desktop 使用场景覆盖。`displayReason` 的视觉渲染未在真实浏览器中人工验收（源码层面已确认是标题单行）。

---

## 3. 重要发现与设计修订

1. **`displayReason` 必须单行**：改为 `越界写入：path（范围：glob）`、`敏感删除：path（删除 N 行，规则 ID）`。多行/富文本留给侧栏（P1）。
2. **`never` 必须插件自己判**：若返回 `ask`，DSH 管道会走 `approval.request` 并得到 `rejected`；这会在用户完全关闭审批时把插件变成“锁死”。P0 用 `overrideOf` + `config.policy` 识别 `never`，按配置降级并审计。
3. **fs 安全网必须 `prepend`**：`fs/*-intent` 是单槽 waterfall，内置 `fs-observation-policy` 会直接返回 intent 而不调用 `next()`；后注册的监听器永远不会执行。P0 以 `{ prepend: true }` 注册，并在非适用场景调用 `next()` 让出决策。
4. **fs 安全网只覆盖遵循约定的工具**：只有工具主动 `waterfall('fs/write-intent', target, actor, ...)` 时才可见；绕过 `ctx.fs` 或 `fs/*-intent` 的写入（例如直接 `fs.writeFile`、bash）不覆盖。README 与 SECURITY 已写明。
5. **`apply_patch` 默认未启用**：Desktop/headless 的 `tool-fs` 行是 `applyPatch: false`；适配器仍支持，其他 profile 打开后可生效。
6. **审批无 answerer 的情形不可由钩子区分**：审批服务存在、策略 `ask`、但没有 UI answerer 时，插件返回 `ask`，由 DSH 管道 fail-closed 成拒绝。`onApprovalUnavailable: allow` 只能救“无服务 / `never`”两种可判定情形；README 写明。
7. **路径判定必须走 `ctx.fs.resolve`**：只做 `path.resolve(cwd, arg)` 会漏掉 `~` 展开与符号链接 realpath（DSH 写入的是解析后的目标）。P0 在 pre-execute 里对每个 target 调 `ctx.fs.resolve`，用 `displayPath` + `targetKey` 共同判定；同步 guard 仍按词法路径，只作最后防线。

---

## 4. 测试与性能

| 项 | 结果 |
|---|---|
| 单元/集成测试 | `node --test "test/*.test.js"`：**116 passed / 0 failed**（glob、scope、rules、adapters、decide、audit、config、projection、client 分组/注册、plugin 生命周期、approval 回执、fs realpath 安全网、fs intent 委托） |
| 真实 DSH e2e | 两条均 PASS：`e2e/run.mjs`（never + fs 安全网）、`e2e/approval.mjs`（ask→拒绝 / ask→允许 + approval 审计） |
| 决策性能基准 | 2,000 次范围内 write 决策，P95 < 50ms、均值 < 10ms（单测断言；本机实际远低于） |
| 隐私 | 审计白名单丢弃 `content`/`old_string`；e2e 断言审计文本不含敏感源码 |

---

## 5. 未验证 / 已知限制（交付时保留）

1. 真实浏览器里的浅色/深色、窄栏布局与点击跳转：P1 tab body 已通过 Client Inspect 确认 active，但视觉/交互未人工验收。
2. 真实 Web `ApprovalPanel` 的人工点击/渲染未验收；但真实 DSH 审批管道已用 fake answerer 覆盖 ask→`rejected` 与 ask→`allowed-once`（`e2e/approval.mjs`），包括 `approval/asked`/`decided` 与插件审计回执。
3. `bash` / `pwsh` / MCP / 绕过 `fs/*-intent` 的写入不拦截。
4. 子 Agent：全局 pre-execute 会覆盖其调用；`fork` 复制父前缀（含 `command/run`）所以继承范围，`spawn` 子 Agent 是新会话、不自动继承父范围（P0 未做显式继承）。
5. 大文件/远程 fs：`readText` 无 `maxBytes` 参数，依赖 `stat.size` 上限；后端不报 size 时可能先整读再丢弃。
6. 审批不可用但服务存在且无 answerer 时，`allow` 降级不生效（见 §3.6）。
7. P1 只显示当前会话最近一次 `workspace/changes`；分组是目录/入口启发式，无导入图；单元排序不含敏感/越界状态（范围在顶部展示）。
