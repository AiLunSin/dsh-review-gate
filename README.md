# dsh-review-gate

> **状态：P0 已实现，真实 DSH `0.2.2-rc.3` headless 冒烟通过。** 发布名为 `@ailunsin/dsh-review-gate`（npm 上无 scope 的 `dsh-review-gate` 已被无关项目占用）。P1 审查编排（侧栏页签、顺序导航）尚未实现。

**给 DeepSeek Harness 加上"写入前的确定性边界"和"写入后的审查顺序"。**

不是又一个 diff 查看器。DSH 已经能看 diff 了——它缺的是：**这次改动越界了吗？删掉的是安全校验吗？我该先看哪个文件？**

---

## 它解决什么

| 场景 | 没有 review-gate | 有 review-gate |
|---|---|---|
| 你只让 AI 修 `src/auth/`，它顺手改了 `src/utils/` | 你事后在 diff 里发现 | 写入前判定：范围内静默，越界 `ask` 或 `deny` |
| 重构时删掉了 `if (!user.hasPermission(...))` | 靠人肉逐行比对 | 确定性规则命中，阻断或询问 |
| 事后被问"这条删除为什么放行" | 无法举证 | 一行一条审计：规则 ID、路径、决策、耗时 |
| 一轮改了 12 个文件 | 平铺列表，先看哪个？ | 3–5 个审查单元，入口优先（P1） |

## 与 diff 类插件的分工

| | diff 类插件（含 DSH 内置改动卡） | dsh-review-gate |
|---|---|---|
| 介入时机 | 修改后 | **修改前控制**（P0） |
| 审查对象 | 代码差异 | **边界、规则、顺序** |
| 判断方式 | 人读 / LLM | **确定性规则** |
| 渲染 diff | 自己实现 | **跳转内置 `changes-review` 页签，不重绘**（P1） |

我们不做：diff 渲染、预测 diff、确认式放行、LLM 代码质量评审、通用 hooks 运行时。

## 安装

当前版本是本地/源码分发；npm 与 GitHub 产物随发布准备（见 [发布](#发布) 与 [`docs/release.md`](docs/release.md)）。

```text
# 开发安装：插件管理器 → Add plugin → 填本仓库绝对路径
# 或（DSH CLI 在 PATH 时）：
dsh plugin add C:\Users\11403\Desktop\one_too

# npm 发布后：
dsh plugin add @ailunsin/dsh-review-gate@0.1.0
```

安装后在新会话里检查 **Plugins** 中的 **Review gate** 行；改配置后按 DSH 的提示重启或让 HMR 生效。

## 快速开始

```text
/review-scope src/auth/**  !src/**/*.test.*
```

声明之后：

- 写 `src/auth/login.ts` → 静默放行
- 写 `src/utils/helper.ts` → 审批弹窗（默认 `ask`）。拒绝后 Agent 收到
  `Error: [review-gate] ...`；如果当前会话审批策略是 `never`，按
  `onApprovalUnavailable` 处理（默认 `deny`）。
- 删除含 `hasPermission(` / `if (!` / `validate(` 的行 → 命中规则，默认 `ask`；规则可配成 `block`
- `/review-scope` → 回显当前范围；`/review-scope clear` → 清除

**未声明范围 = 放行但审计**（`unscoped=true`）。这是刻意选择：装上就处处弹窗的插件没人用。

## 配置

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: review-gate
  name: '@ailunsin/dsh-review-gate'
  config:
    enabled: true
    locale: auto                 # auto | zh | en（Host 文案；审批标题始终带 en + zh）
    scope:
      enforce: true
      default: ['src/**']        # 没有 /review-scope 时使用；空数组 = 不拦截
      strict: false              # true: 越界直接 deny（默认 ask）
      caseSensitive: false       # Windows 默认不敏感
    rules:
      enabled: true
      disabled: [RG-VALID-003]   # 关闭单条默认规则
      ignorePaths: ['**/*.test.*', '**/fixtures/**', '**/generated/**']
      custom:
        - id: RG-AUTH-001        # 同 ID 覆盖默认规则
          title: 鉴权检查删除
          severity: block        # ask | block
          appliesTo: [edit, write, apply_patch, str_replace_editor]
          patterns: ['hasPermission\s*\(', 'isAuthori[sz]ed\s*\(']
          ignorePaths: ['**/*.test.*']
    protectedPaths: ['.git/**', '**/.git/**', '**/*.pem', '**/*.key']
    onApprovalUnavailable: deny  # deny（默认）| allow
    onInternalError: allow       # 插件自身异常：放行 + 审计 degraded
    limits:
      preExecuteMs: 80
      readFileBytes: 262144
      readFileMs: 20
      ruleMs: 5
      auditQueue: 1000
    audit:
      enabled: true
      dir: ''                    # 空 = $DSH_HOME/review-gate/audit
      maxFileBytes: 8388608
```

未知字段、非法枚举、非法 glob 在插件激活时**直接报错**，不会静默忽略。

## 决策矩阵

| 情况 | 审批可用 | 审批不可用（无服务 / `never`） |
|---|---|---|
| 受保护路径 | `deny` | `deny` |
| 命中 `severity: block` 规则 | `deny` | `deny` |
| 越界（`scope.strict=false`） | `ask` | `onApprovalUnavailable`（默认 `deny`） |
| 越界（`scope.strict=true`） | `deny` | `deny` |
| 命中 `severity: ask` 规则 | `ask` | `onApprovalUnavailable` |
| 插件内部异常 / 超时 | 按 `onInternalError`（默认 `allow` + 审计 `degraded`） | 同左 |
| 范围内、无命中 | `allow` | `allow` |

优先级：`deny(protected)` > `deny(block rule)` > `deny(strict scope)` > `ask(scope/rule)` > `allow`。

## 审计

每次决策写一行 JSONL，默认 `$DSH_HOME/review-gate/audit/audit-YYYY-MM-DD.jsonl`：

```json
{"v":1,"ts":"2026-11-17T00:00:00.000Z","type":"decision","sessionId":"…","tool":"write","callId":"…","decision":"ask","reason":"scope-violation","path":"src/utils/helper.ts","scope":["src/auth/**"],"scopeSource":"command","rules":[],"deleted":0,"approval":"available","durationMs":3.1}
```

- 只存路径、规则 ID、行号、短哈希、决策和耗时；**不存文件正文、`old_string`、diff**。
- 审批实际结果另记一行 `type:"approval"`（`outcome=allowed-once|rejected|cancelled|unavailable`）。
- 队列写盘，写失败只告警一次，不影响工具调用；`audit.enabled=false` 完全关闭。

## 已知限制（请先读）

1. **不拦 shell。** `bash` / `pwsh` / MCP 工具直接写文件不受本插件约束；`fs/*-intent` 安全网只覆盖**主动经过该事件**的文件工具。需要硬边界时配合 DSH 沙箱模式。
2. **审批不携带参数。** 路径、范围、规则都写在插件生成的 `displayReason` 标题里（单行）；审批请求本身只带 toolName/reason/callId。
3. **`write` 的删除检测是行级近似**，不保证与最终落盘逐行一致；超过 `limits.readFileBytes` 或读不到旧文件时跳过删除检测（规则不产生命中记录，审计仍记录决策）。
4. **未声明范围 = 不拦截**（只审计）。`/review-scope clear` 清除后同样只审计。
5. **审批服务存在但无 answerer 时**（headless / 无 UI），`ask` 由 DSH 管道 fail-closed 成拒绝；`onApprovalUnavailable: allow` 只能覆盖"无审批服务 / 策略 never"两种可判定情形。
6. **子 Agent / fork**：`fork` 会复制父会话前缀（含 `command/run`），因此范围随 fork 继承；`spawn` 子 Agent 是新会话，scope 取自子会话自身，不自动继承父范围。全局 pre-execute 会拦子 Agent 的写入。
7. **符号链接 / `~`**：主门通过 `ctx.fs.resolve` 使用扩展后的绝对路径与后端 realpath 判定；同步 `tools.guard` 仍只能按词法路径，作为最后防线。需要符号链接级硬边界时配合 DSH 沙箱。
8. P1 的审查单元/顺序导航依赖内置 `changes-review` 与 `/api/changes.*`，尚未实现与验证。

## 兼容性

- DSH `0.2.2-rc.3`（`engines.dsh` 精确锁定；DSH 发版后同步验证升级）。
- 要求 profile 组成 `@deepseek-ai/dsh-session-projection`（shipped `dsh-base` 已包含）；没有该服务时插件不会激活，而不是静默降级。
- `commands` / `fs` / `approval` 是可选服务：缺失时 `/review-scope`、fs 安全网或审批降级分别不可用，但配置默认范围与规则仍然工作。

## 开发

```text
node --test "test/*.test.js"   # 106 tests
node e2e/run.mjs               # 真实 DSH headless：never 策略 + fs 安全网
node e2e/approval.mjs          # 真实 DSH headless：ask → 拒绝 / ask → 允许 + approval 审计
node scripts/check-syntax.mjs
node scripts/build-release.mjs --name @ailunsin/dsh-review-gate
```

无构建步骤：`src/*.js` 就是运行文件，Host 半只依赖 Node 内置模块与 DSH 的公开服务。

## 发布

发布形态（D4）：GitHub + npm + 自建索引。

- GitHub：`AiLunSin/dsh-review-gate`（本地仓库已初始化；远程推送需仓库创建/凭据）
- npm：`@ailunsin/dsh-review-gate`（`npm whoami` 当前 E401，需账号持有人 `npm login`）
- 索引：仓库根 `index.json`，格式按 DSH 官方 `plugin-market` 校验

具体命令与阻塞项见 `docs/release.md`。

## 路线图

- [x] 需求分析（v0.2，已按 DSH 0.2.2-rc.3 源码核验）
- [x] 技术方案（v0.2）
- [x] 决策定稿（D1–D4，F-13/F-14 砍掉）
- [x] M0 技术验证（4/6 关闭，2 项 P1 顺延）
- [x] M1 P0：范围门 + 敏感删除 + 审计 + 审批文案 + fs 安全网
- [ ] M2 P1：审查单元与顺序导航（侧栏页签）
- [ ] M3 P2：导入图分组、决策源标注

## 文档

- [需求分析报告](docs/requirements-analysis.zh-CN.md)
- [技术方案](docs/technical-design.zh-CN.md)
- [决策记录](docs/decisions.md)
- [M0 技术验证](docs/spike-m0.md)

## License

MIT
