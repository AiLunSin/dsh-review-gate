# dsh-review-gate 需求分析报告

| 项目 | 内容 |
|---|---|
| 文档版本 | v0.2（对 v0.1 草案的核验修订版；2026-11-17 按 D1–D4 决策定稿，见 `docs/decisions.md`） |
| 日期 | 2026-11-17 |
| 核验基线 | DeepSeek Harness `0.2.2-rc.3`（Desktop profile，MIT） |
| 核验方式 | 读取已安装 ASAR 内包源码与 README；加载官方 `dsh-doc` 参考；公开生态检索 |
| 结论状态 | 方向成立；原草案 3 处技术前提需修正；F-13/F-14 已砍掉（2026-11-17 定稿） |

> 本文所有"DSH 支持 X"的判断均给出包名与文件位置，便于复核。标注 **【未验证】** 的条目是 M0 技术验证必须关闭的问题，不作为本文结论基础。

---

## 0. 结论摘要

1. **定位成立，但要换一个卖点。** 单纯"审查体验 / diff 渲染"已无空间：DSH 内置 `dsh-workspace-changes` + `ui-deliverables` 已经提供"每轮改动文件卡 + 逐文件 hunks 对比"，第三方也已有多款 diff 插件。真正空白的是**以"人类声明的修改范围"为契约的确定性边界控制**与**审查顺序编排**。
2. **三处前提需修正：**
   - **F-06"会话流卡片"不能按原样实现**：第三方插件不能为会话新增事件类型，Chat 行只能匹配**既有 durable 事件**。控制提示必须落在审批弹窗文案、命令回显、侧栏页签三处。
   - **"ask 会展示路径与规则"不成立**：审批请求只携带 toolName、reason、可选 callId，不携带工具参数。路径与规则必须写进 `reason` / `displayReason` 文本，或跳到侧栏面板查看。
   - **F-02 的 `ask` 在 `never` 策略下会变成拒绝**：审批不可用时管道 fail-closed。必须显式设计降级策略，否则 CI / 关闭审批的会话会被"看似增强、实则锁死"。
3. **F-13 / F-14 砍掉（最终决定）。** 公开生态中 `dsh-diff-review` 已实现"写入前弹 diff、接受才落盘"，`dsh-plugin-diff-viewer` 已实现结构化 diff 捕获与块级高亮。继续投入是重复建设，且 500ms 预算会拖累每条写入。只保留"影响摘要"（改几行、命中哪些规则）写进审批文案，不单独成为功能项，也不做确认式放行。
4. **可上架的最小闭环（P0）**：范围声明（`/review-scope`）+ 路径越界判定 + 敏感删除规则 + 决策与审计 + 审批文案。5 周可交付（1 周 spike + 4 周开发）。
5. **必须提前接受的两个硬限制**：① 只能约束 `write` / `edit` 这类文件工具，**无法确定性拦截 bash/pwsh 或 MCP 工具的写文件行为**；② 插件无法保证"预览与落盘完全一致"（TOCTOU），只能依靠 `fs` 版本守卫兜底。

---

## 1. 背景与问题定义

### 1.1 两类真实失败模式

| 失败模式 | 典型表现 | 现有机制的盲区 |
|---|---|---|
| **越界修改** | 修 A 接口的空指针，顺手重构 B 模块、删除安全校验、写入未授权目录 | 审批 UI 只显示"工具名 + 理由"，不显示**目标路径与声明范围的关系**；LLM 审查对"结构性越界"不稳定 |
| **审查失序** | 一轮改 12 个文件，平铺列表导致漏审、先看叶子后看入口 | 内置改动卡按 `display` 路径排序，不表达"该先看哪个"、"哪些属于同一数据流" |

### 1.2 为什么现在做

- DSH 已把**工具调用管线**（`tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result`）与**审批 seam**（`ctx.approval`）做成稳定扩展点，第三方插件因此能在写入前参与决策。
- 同一时期 DSH 交付了 `workspace/changes` 与改动卡，说明"变更的结构化数据"已成为一等公民，审查编排有了数据底座。
- 生态侧四款 diff 插件都围绕"看差异 / 写前对照"，**没有一家**把"范围契约 + 删除敏感 + 顺序编排"作为核心。差异化窗口仍在。

---

## 2. 生态与竞品核验

### 2.1 DSH 内置能力（决定了"不要重复造什么"）

| 能力 | 包 | 与本项目的关系 |
|---|---|---|
| 工具调用前决策 `allow/deny/cancel/ask` | `dsh-tools`（`src/contracts.ts:375-379`） | **主拦截点**，复用 |
| 一次性人工审批、fail-closed、审计事件 | `dsh-user-approval`（`ctx.approval`，`approval/asked` / `approval/decided`） | `ask` 的落地通道，复用 |
| 审批弹窗（composer takeover） | `dsh-client-ui-approval`（`ApprovalPanel`） | 展示 `displayReason`，不自定义 |
| 权限预设（ask / never） | `dsh-permission-presets` | 必须兼容，设计降级 |
| LLM 逐工具授权审查 | `dsh-experimental-auto-review`（可选装） | **语义审查的竞品**，本项目走确定性规则，二者可叠加 |
| 先读后写（read-before-edit）、版本守卫、`fs/*-intent` 门 | `dsh-fs-observation-policy`、`dsh-fs` | **辅拦截点**（解析后的真实目标）与 TOCTOU 兜底 |
| 每轮改动捕获 + 逐文件 hunks | `dsh-workspace-changes`、`ctx.workspaceChanges.summary()/diff()` | P1 审查编排的数据源 |
| 改动卡 + `changes-review` 页签 | `dsh-client-ui-deliverables`（`/api/changes.*`、`dsh-resource://changes-review/...`） | **diff 渲染直接复用**，不重写 |
| Claude Code / Codex hooks 桥 | `dsh-hooks-claude-code`、`dsh-experimental-claude-code-mods` | 说明"钩子式拦截"已被覆盖，本项目不做通用 hooks 运行时 |

### 2.2 第三方插件（公开检索，未逐一安装验证）

| 插件 | 行为 | 与本项目重叠 |
|---|---|---|
| `dsh-diff-review` | 写文件前弹 diff，接受才落盘 | **F-13 / F-14 已被实现** |
| `dsh-client-ui-diff-panel` | 右侧面板实时展示 edit/write 变更 diff | UI 侧重叠（本项目不做） |
| `dsh-plugin-diff-viewer` | 捕获 fs 写改、生成结构化 diff、块级高亮 | F-09 数据层已被实现（本项目直接消费 `workspace/changes`） |
| `@rooode/dsh-plugin-git` | WebStorm 风格提交与并排 diff | 无重叠 |

**结论：** 不要在"看 diff"上竞争。可竞争的是**"能不能改、为什么不能改、先看什么"**。

### 2.3 空白矩阵

| 维度 | 内置 | 第三方 diff 插件 | dsh-review-gate |
|---|---|---|---|
| 修改范围契约 | 无（审批只看工具名） | 无 | **有**（声明 + 越界判定） |
| 安全敏感删除 | 无 | 无 | **有**（确定性规则） |
| 审查顺序编排 | 按路径排序 | 无 | **有**（入口/风险排序） |
| 决策可追溯 | 审批审计（log-only） | 无 | **有**（JSONL + 规则 ID） |
| diff 渲染 | 有 | 有 | 复用 |

---

## 3. 用户与场景（修正版）

| 角色 | 关注点 | 成功体验 |
|---|---|---|
| 独立开发者 | 不被 AI "顺手改坏"，但不想每条写入都弹窗 | 范围内静默，越界才打断 |
| 团队 Reviewer | 12 个文件里先看哪 3 个 | 3–5 个审查单元，入口优先 |
| 平台/安全负责人 | 事后能举证"这条删除为什么放行" | 按规则 ID 检索审计日志 |

### 场景重写

**A. 越界拦截（可验收）**
用户先执行 `/review-scope src/auth/**`。Agent 调 `write` 写 `src/utils/helper.ts` → 插件返回 `ask`，审批弹窗标题显示"越界写入：src/utils/helper.ts（范围 src/auth/**）"。用户拒绝 → Agent 收到 `Error: [review-gate] scope-violation ...`，会话继续。
*注：路径与范围只能出现在 reason/displayReason 文本中，审批请求本身不带参数。*

**B. 安全敏感删除（可验收）**
`edit` 的 `old_string` 含 `if (!user.hasPermission('admin'))` → 命中 `RG-AUTH-001`，按配置返回 `ask`（默认）或 `deny`；工具卡失败原因带规则 ID 与行号区间。

**C. 多文件审查编排（P1）**
一轮改 12 个文件 → 侧栏"审查顺序"页签呈现 3–5 个单元，每单元附"为什么先看它"；点击文件跳转内置 `changes-review` 页签，不重绘 diff。

**D. 修改前影响预览（不做）**
F-13/F-14 已砍掉：不生成预测 diff，也不接管落盘确认。只在审批文案里给一行影响摘要（删除 N 行、命中哪些规则、涉及哪个受保护路径）。

---

## 4. 需求重排

### 4.1 逐条结论

| 原编号 | 结论 | 理由 | 新落点 | 阶段 |
|---|---|---|---|---|
| F-01 订阅 pre-execute | **保留** | 唯一同时拥有 agent/callId/args 且能 ask 的门 | `ctx.on('tools/pre-execute')` | P0 |
| F-02 路径边界检查 | **保留，补第二道门** | 工具级看不到解析后的真实目标；跨工具族易漏 | pre-execute 判定 + `fs/*-intent` 兜底（仅未映射工具/受保护路径） | P0 |
| F-03 敏感删除检测 | **保留** | 生态空白点，确定性可测 | 规则引擎（删除行匹配） | P0 |
| F-04 范围声明解析 | **改写** | "解析首条指令"准确率不可接受，且不可审计 | `/review-scope` 命令（durable）+ 配置默认值；首条指令解析默认关闭 | P0 |
| F-05 决策返回 | **保留** | 契约清晰 | `PreToolDecision` | P0 |
| F-06 会话流卡片 | **改写** | 第三方不能新增会话事件类型 | 审批弹窗文案 + 命令回显 + 侧栏页签（P1） | P0/P1 |
| F-07 配置入口 | **保留** | Cordis Config（schemastery） | patch `config:` 覆盖 | P0 |
| F-08 审计日志 | **保留** | 可追溯是卖点 | JSONL + 规则 ID | P0 |
| F-09 变更收集 | **改写为实现方式** | 无需自建采集器 | 消费 `workspace/changes` + `ctx.workspaceChanges` | P1 |
| F-10 语义分组 | **保留，先启发式** | 符号图成本高，价值递增 | 路径/入口启发式 → 导入图增强 | P1 → P2 |
| F-11 顺序引导 | **保留** | 核心差异化 | 侧栏页签 + 上/下一组 | P1 |
| F-12 与 diff 渲染解耦 | **保留** | 用 `dsh-resource://changes-review/...` 跳转 | 复用内置页签 | P1 |
| F-13 预测 diff | **砍掉** | 与 `dsh-diff-review` 重复；500ms 预算伤性能 | 不做；只在审批文案保留影响摘要 | — |
| F-14 确认式放行 | **砍掉** | 同上；确认能力已由审批弹窗提供 | 用 `ask` + 影响摘要替代 | — |
| F-15 决策源抽取 | **保留** | 纯本地、可校对 | ADR / `@decision:` / CLAUDE.md | P2 |
| F-16 矛盾标注 | **保留，仅建议性** | 误报风险高 | 侧栏标注，不阻断 | P2 |

### 4.2 为什么砍掉 F-13/F-14

| 维度 | 完整预测 diff | 影响摘要（保留在文案里） |
|---|---|---|
| 开发成本 | 需模拟 write/edit/str_replace/apply_patch 语义 | 读旧文件 + 行数差 + 规则扫描 |
| 性能 | 中等文件 100–300ms，逼近 500ms 上限 | <50ms |
| 准确性 | 与落盘存在 TOCTOU；`replace_all`、编码、换行差异 | 只承诺"影响范围"，不承诺逐行一致 |
| 差异化 | 已被 `dsh-diff-review` 占据 | 尚无竞品 |

**最终决定（2026-11-17）：** F-13/F-14 整条砍掉。"看得到将要发生什么"交给 `dsh-diff-review`；本插件只回答"这次改动越界了吗、删了不该删的吗、该先审哪里"。审批文案里保留一行影响摘要，但不做 diff、不做确认式放行。

### 4.3 P0 功能需求（细化为可验收条目）

| ID | 需求 | 行为 | 验收要点 |
|---|---|---|---|
| RG-1 | 范围声明 | `/review-scope <glob...>` 记录声明；`/review-scope clear` 清除；`/review-scope` 无参回显当前范围 | 声明后会话日志出现 `command/run` 事件，可回放；刷新后范围仍在 |
| RG-2 | 越界判定 | 目标路径不在声明 glob 内 → 按配置 `ask`（默认）或 `deny` | 声明 `src/auth/**` 后写 `src/utils/x.ts` 触发；写 `src/auth/a.ts` 静默 |
| RG-3 | 解析后复核 | 已映射工具由主门判定；`fs/write-intent` / `fs/edit-intent` / `fs/delete-intent` 只对**未映射工具**与受保护路径兜底（避免"审批允许后又被拒"） | 新增文件工具族仍受约束；已映射工具不出现二次决策冲突 |
| RG-4 | 敏感删除 | 从 `edit.old_string`、`write` 旧内容差集、`str_replace_editor.old_str` 提取删除行，匹配规则集 | 删除含 `hasPermission` 的行触发；删除注释/空行不触发 |
| RG-5 | 白名单 | 按路径 glob、规则 ID、行内 `review-gate-ignore` 放行 | 三条白名单各有一条正/反用例 |
| RG-6 | 决策 | 返回 `allow` / `ask`（带 `reason` + 本地化 `displayReason`）/ `deny`（带 `info.code`） | 决策类型符合 `PreToolDecision` 联合 |
| RG-7 | 审批不可用降级 | 无 `ctx.approval` 或策略为 `never` 时按配置 `deny`（默认）或 `allow`+审计 | CI 场景不静默放行、也不无提示锁死 |
| RG-8 | 审计 | 每次决策写一行 JSONL，不含文件内容 | 可按 sessionId / 规则 ID 检索；写入失败不影响主流程 |
| RG-9 | 故障降级 | 规则解析失败、超时、payload 变化 → 放行 + 告警（可配 deny） | 注入异常后会话继续，日志有 `degraded` 记录 |
| RG-10 | 卸载清理 | `ctx.effect` 注册全部副作用 | 停用插件后无监听器、无页签、无命令 |

### 4.4 P1 / P2

- **P1**：审查单元分组（路径/入口启发式）、顺序导航、跳转内置 diff、`/review-gate` 侧栏页签。
- **P2**：导入图分组（读文件解析 import）、ADR 决策源抽取与矛盾标注。（预测 diff / 确认式放行已砍，不再排期。）

---

## 5. 非功能需求（可度量）

| ID | 指标 | 目标 | 测量方法 |
|---|---|---|---|
| N-01 | pre-execute 增量耗时 | P95 < 20ms，P99 < 80ms（含 ≤256KB 旧文件读取）；非文件工具 < 1ms | 插件自埋点 + 基准测试 |
| N-02 | 故障隔离 | 任何钩子异常不改变工具结果（除配置的 fail-closed） | 注入测试 |
| N-03 | 可逆性 | 卸载后 0 残留监听/页签/命令/定时器 | 卸载后断言 |
| N-04 | 兼容 | payload 结构不匹配时降级放行 + 告警 | 契约测试 + 版本适配层 |
| N-05 | 隐私 | 审计仅存路径与规则 ID；不存文件内容/old_string | 代码审计 + 日志抽样 |
| N-06 | 可配置 | 所有阈值/规则/决策可覆盖，默认值可用 | 配置 schema 测试 |
| N-07 | 幂等 | 同一次调用重复判定结果一致 | 单测 |
| N-08 | 并发 | 并行工具调用（`isConcurrencySafe`）下无共享可变状态 | 并发测试 |

---

## 6. 范围与非目标

**范围内**：`write` / `edit`（及同族 `str_replace_editor`）的写入前控制；范围契约；敏感删除；审计；审查顺序。

**明确不做**：

- 拦截 shell（`bash` / `pwsh`）与 MCP 工具的写文件行为——**无法确定性做到**，只能靠沙箱模式。文档与 README 必须写明。
- 自定义 diff 渲染器。
- 自定义审批弹窗（只把信息写进 `displayReason` 文本，不替换内置审批组件）。
- 通用 LLM 代码质量审查。
- 跨会话知识库。

---

## 7. 风险登记册

| # | 风险 | 概率 | 影响 | 缓解 | 触发信号 |
|---|---|---|---|---|---|
| R1 | DSH 预览版事件/字段变更 | 高 | 拦截失效 | 版本适配层 + `engines.dsh` 精确锁定 + 降级放行 | 升级后 `degraded` 日志增多 |
| R2 | `ask` 在 `never` 策略下 fail-closed | 中 | 会话被锁死 | RG-7 显式策略 + 文案提示 `/permission` | 用户反馈"突然不能写" |
| R3 | 敏感规则误报 | 高 | 干扰正常修改 | 默认 `ask` 不 `deny`；白名单；规则可单条关 | 拒绝率 > 20% |
| R4 | 范围声明语法不熟 | 中 | 形同虚设 | `/review-scope` 回显 + 侧栏状态 + 默认"未声明=放行但审计" | 审计中 `unscoped` 占比高 |
| R5 | 依赖内置 `/api/changes.*` 与 `changes-review` 地址 | 中 | P1 导航失效 | 版本适配 + 降级为文件清单 | 升级后页签空白 |
| R6 | 与 `dsh-diff-review` 功能重叠被质疑 | 中 | 定位模糊 | README 明确"不弹 diff，只判边界"；放弃 F-13/F-14 | 用户提问"和 diff-review 有什么区别" |
| R7 | 审批不传参数导致信息不足 | 高 | 用户乱点允许 | `displayReason` 首行给路径/规则/范围；侧栏可查详情 | 审批通过率异常高 |
| R8 | TOCTOU：判定后文件被改 | 低 | 越界落盘 | 依赖 `fs-observation-policy` 版本守卫；审计记录版本 | 版本冲突日志 |

---

## 8. 成功指标

| 层级 | 指标 | 目标（上线 4 周） |
|---|---|---|
| 北极星 | 越界写入被拦截并被人确认的比例 | ≥ 60%（其余为范围内静默） |
| 质量 | 敏感删除误报率 | < 15% |
| 效率 | 12 文件改动的首轮审查覆盖率 | 从基线提升 ≥ 25% |
| 性能 | pre-execute P95 增量 | < 20ms |
| 采用 | 安装后 7 日留存 | ≥ 40% |
| 信任 | 用户手动关闭插件的比例 | < 10% |

---

## 9. 里程碑与估算

| 阶段 | 范围 | 工期 | 出口条件 |
|---|---|---|---|
| M0 技术验证 | 6 项 spike（见技术方案 §18），其中 3 项决定架构：`displayReason` 渲染、`approval` 策略读取、`fs/*-intent` 的 actor 能力 | 1 周 | 6 项有结论，架构项不通过则调整方案 |
| M1 P0 | RG-1…RG-10 | 4 周 | §10 验收 1–6 全绿 |
| M2 P1 | 分组/排序/导航/页签 | 3 周 | 验收 7–9 |
| M3 P2 | 导入图、决策源 | 2–3 周 | 验收 10 |

人力假设：1 名熟悉 TS/Cordis 的开发者；M2 需 0.5 人前端。

---

## 10. 验收清单（Given / When / Then）

| # | Given | When | Then |
|---|---|---|---|
| 1 | 已 `/review-scope src/auth/**` | Agent `write` `src/utils/helper.ts` | 返回 `ask`；弹窗含路径、范围、规则；拒绝后 Agent 收到 `Error: [review-gate] ...` |
| 2 | 同上 | Agent `write` `src/auth/login.ts` | 返回 `allow`，无弹窗，审计一行 `decision=allow` |
| 3 | 规则 `RG-AUTH-001` 启用 | `edit` 删除含 `hasPermission` 的行 | 命中并 `ask`；删除纯注释含同词不命中 |
| 4 | 审批策略 `never` | 越界写入 | 按配置 `deny`（默认），理由提示切换权限预设 |
| 5 | 规则文件损坏 | 任意 `edit` | 放行；审计 `degraded=true`；会话不中断 |
| 6 | 任意时刻 | 停用插件 | 监听器/命令/页签全部消失；无报错 |
| 7 | 一轮改 8 文件（P1） | 打开"审查顺序"页签 | 3–5 个单元，含"为什么先看"；上/下一组可用 |
| 8 | 同上（P1） | 点击单元内文件 | 打开内置 `changes-review` 页签，不重绘 diff |
| 9 | 无 git / 无 `workspace/changes`（P1） | 打开页签 | 降级为工具级文件清单，不报错 |
| 10 | 仓库含 ADR（P2） | 改动与决策冲突 | 侧栏建议性标注 + 引用原文；可关闭 |

---

## 11. 四个待决问题（已定稿）

| # | 问题 | 选项 | 最终决定 |
|---|---|---|---|
| D1 | 越界默认动作 | `ask` / `deny` | **`ask`**（误报可撤销，不阻断工作流） |
| D2 | 审批不可用时 | `deny` / `allow`+审计 | **`deny` + 配置开关**（`onApprovalUnavailable: deny \| allow`） |
| D3 | F-13/F-14 | 完整实现 / 降级 / 砍掉 | **砍掉**（只保留审批文案里的影响摘要） |
| D4 | 发布形态 | 仅 GitHub / GitHub + npm / 三者都做 | **三者都做**：GitHub + npm + 自建索引 |

定稿记录见 [`docs/decisions.md`](decisions.md)。npm 无 scope 名称 `dsh-review-gate` 已被无关项目占用，发布名使用 `@ailunsin/dsh-review-gate`。

---

## 附录 A：核验证据索引

| 结论 | 证据 |
|---|---|
| 决策联合类型 | `@deepseek-ai/dsh-tools/src/contracts.ts:375-379` |
| 参数不可改写 | `@deepseek-ai/dsh-tools/README.md:197` |
| `ask` 走审批、fail-closed | `@deepseek-ai/dsh-tools/src/pipeline.ts:444-464`；`dsh-user-approval/README.md:28,53,167` |
| 审批请求不带参数 | `dsh-user-approval/README.md:166` |
| `displayReason` 被弹窗渲染 | `dsh-client-ui-approval/src/client/ApprovalPanel.tsx:11-14` |
| `fs/*-intent` 门 | `dsh-fs/src/index.ts:58-94`；`dsh-fs-observation-policy/src/index.ts:78-97` |
| `workspace/changes` 与 diff API | `dsh-workspace-changes/README.md:12,48`；`src/types.ts:5-76` |
| 改动卡路由与页签地址 | `dsh-client-ui-deliverables/src/changes.ts:111-146`；`review-definition.ts:38-49` |
| 命令事件 durable | `dsh-commands/src/index.ts:373-378` |
| 插件不得新增事件类型 | `dsh-session/README.md:72`（`appendPluginRecord` 仅限实验包） |
| Chat 行契约 | `dsh-client-ui-conversation/src/client/contract/conversation.ts:213-222` |
| 侧栏页签注册 | `dsh-client-ui-sidebar-right/src/client/tab-registry.ts:94-120` |
