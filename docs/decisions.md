# 决策记录（2026-11-17 定稿）

本文件记录 v0.2 需求分析 §11 四个待决问题的最终结论。README、需求分析、技术方案与实现均以本文件为准。

| # | 问题 | 决定 | 落地 |
|---|---|---|---|
| D1 | 越界默认动作 | **`ask`** | `scope.strict=false` 时越界返回 `ask`；`scope.strict=true` 才直接 `deny` |
| D2 | 审批不可用时 | **`deny` + 配置开关** | `onApprovalUnavailable: deny`（默认）\| `allow`；`allow` 时审计记 `degraded=true` |
| D3 | F-13 / F-14 | **整条砍掉** | 不做预测 diff、不做确认式放行；只保留“影响摘要”文案（删除行数、命中规则数），不单独成为功能项 |
| D4 | 发布形态 | **三者都做** | GitHub 仓库 + npm 包 + 自建市场索引 `index.json` |

## 补充决定

- **npm 名称**：`dsh-review-gate` 在 npm 已被一个无关项目占用（0.2.0，post-turn code review）。本项目 npm 发布名改为 **`@ailunsin/dsh-review-gate`**；仓库内短名仍是 `dsh-review-gate`，插件行 id 为 `review-gate`。
- **F-13/F-14 的替代**：审批文案里给一行影响摘要（例如“删除 3 行，命中 RG-AUTH-001”），不生成 diff、不接管落盘确认。若后续要恢复完整形态，必须在 M3 前重新决策，因为它会与 `dsh-diff-review` 重叠并打破 500ms 预算。
- **D2 的边界**：`onApprovalUnavailable` 只在插件能确定审批不可用时生效（没有 `ctx.approval`，或会话策略为 `never`）。如果审批服务存在但没有任何 answerer（headless / 无 UI），`ask` 由 DSH 管道 fail-closed 变成拒绝，插件无法从钩子里区分“是否有 answerer”；这一路径按拒绝处理，并在 README 写明。
- **D1 的边界**：未声明范围 = 放行但审计（`unscoped=true`），不弹窗。这是 v0.2 的刻意选择。

## 依据

- 需求分析 v0.2 §11：D1–D4 及建议默认值。
- 技术方案 v0.2 §7.1 决策矩阵、§11 配置 Schema。
- 用户 2026-11-17 指示：按上述建议自动推进；审批策略已切换为 `never`，故 D2 的 `never` 分支是本机实测重点。
