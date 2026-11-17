# 0.3.1 / 0.3.2 验证记录（2026-11-17 / 18）

本文件记录 0.3.0 P2 路由 bug 的修复、0.3.1 发布以及 0.3.2 的 UI 恢复与实机验收结果，供下一个版本回归时对照。

## 已闭环

- **0.3.0 的问题**：已发布 tarball 内注册的 Fetch 回调按位置参数调用 `handleReviewRequest(ctx, config, request)`，而 handler 只接收一个 options 对象；每个 P2 请求在读取坐标前抛错，客户端静默回退 P1。0.3.1 改为 `handleReviewRequest({ ctx, config, request })`。
- **npm 0.3.1**：2026-11-17T06:18:37Z 发布，31 files；核验 tarball 内路由为 `/api/review-gate.units`、调用为 options 对象、无 `src/review-gate-e2e/` 测试夹具。
- **市场索引**：`index.json` 含 0.3.1（`publishTimestamp=1794896317`），官方解析器 `PASS (plugins=1, versions=2)`；GitHub `main` 内容已确认（blob sha `52aa0519`；本地 2,102 B / sha256 `48558004015baac33e6cd3e8e1c64c1f8aa1ea21dd07dbbc7fb89b62c1c2aceb`）。
- **GitHub Release**：`v0.3.1` 已创建（2026-11-17T10:52:57Z），附件 `ailunsin-dsh-review-gate-0.3.1.tgz` 已上传（80,178 B，digest `sha256:cc8874e57737ae19ae03f283f0bc54224764e89e2a573a4e6c8a5836e51318cd`），与 release body 一致。
- **索引 raw 可达性**：[index-reachability run 44072294082](https://github.com/AiLunSin/dsh-review-gate/actions/runs/44072294082) PASS：raw 200 直出、无重定向，`index.json` 2,102 B / sha256 `48558004015baac33e6cd3e8e1c64c1f8aa1ea21dd07dbbc7fb89b62c1c2aceb` 与仓库一致，`icon.svg` 200 且为 SVG。本机到 raw 域名仍超时，仅影响本机链路。
- **A7 安装验证**：全新 headless profile `dsh plugin add @ailunsin/dsh-review-gate@0.3.1` 成功，`--dump-config` 含 `id: review-gate`；`dsh plugin remove` 后无残留行。
- **B4 决策提示**：实际「审查顺序」页签显示 `DOC-CLAUDE.md:3` / `CLAUDE.md` 的建议性提示，仅命中 `a.test.ts`；`b.test.ts` 无提示。夹具随后已删除。
- **B6 路由活体**：临时 DSH web 实例（真实 0.2.2-rc.3 + 本地 dist）鉴权后请求：`/api/review-gate.units` 返回 400 `sessionId and seq are required.`；带坐标返回 404 `Change summary unavailable.`；`/review-gate.units` 返回 404；对照 `api/changes.summary` 返回 400。
- **B7 审批**：删除 `hasPermission` 行触发 `RG-AUTH-001` + `RG-GUARD-002`，决策 `ask`，审批结果 `allowed-once`，审计同时有 decision 与 approval 记录。
- **B5 数据层**：真实临时文件构造相对 import 链；默认配置返回 `mode: "graph"`，入口单元包含 `index.ts`/`auth/login.ts`/`utils/hash.ts`；`review.importGraph: false` 时返回 `mode: "directory"`；客户端在 `client.js` 中渲染 `graphMode`/`directoryMode` 标签。
- **测试**：`139/139` pass，`npm run lint` 通过（43 JS + 4 JSON）。

## B8/B9/B10/B12 验收（0.3.2，computer-use 实机）

以下 B8/B9/B12 为 2026-11-18 的实机验收结果；仓库侧无法复现应用窗口最小宽度和主题切换。

| 项 | 结果 |
|---|---|
| B8 浅/深色 | 浅色页签正常（header、范围、轮次、单元卡、文件行、+N/−N 配色）；设置 → 通用设置 → 外观切到深色后重新渲染，无丢失文字、无低对比残留；验收后恢复“跟随系统”。 |
| B8 窄栏 | 应用最小窗宽 534px（内容区约 520px），页签自适应单列，长路径 `docs/verification-0.3.1.md` 不截断、无横向滚动；390px 精确档无法在应用中达到，改用静态 CSS 检查（无 `min-width: ≥300px`、无 `width:390px`、无 `overflow-x` 硬规则）。 |
| B9 fresh-start | `dsh.client.immediately:false` 已确认；从“应用 → 退出”完全退出（进程全部消失），00:10:47 重启；未做任何插件操作，右栏页签仍注册并渲染，旧轮次显示 0.3.2 的明确提示：“Host 已不再提供本轮的改动数据。请跑一轮新的、会写文件的对话以刷新本页签。”，不再是空白误导态。 |
| B10 配置层 | 临时 profile（0.3.2 tarball）：默认 `--dump-config` 只有 `enabled/scope/onApprovalUnavailable`，无 `review` 段；加 patch 后为 `review.maxUnits: 9`、`review.importGraph: false`、`review.decisionSources: [docs/decisions.md]`，键名与层级被接受、无冲突。 |
| B12 大轮次 | 第 19 轮 7 文件（u1–u6 + 入口 `u3/index.test.ts`）：导入图分组，入口单元第 1，理由“包含入口文件：index.test.ts · 由导入边连接（2 条边）· 改动量 +9/−0”；第 21 轮 6 个独立目录：5 个 chips，最后一个为“其他改动”，触发 `maxUnits: 5` 合并；上/下一组跨 5 组正常；点击 `.tmp/g2/b.ts` 打开“第 21 轮改动”，路径与 diff 对应，未落到首个文件。 |

B5 视觉由 B12 的第 19/21 轮实际页签覆盖（导入图分组、目录分组/其他改动均可见）。

## 验收范围外（按决定忽略）

- **B10 运行中热生效**：配置合成已验证；运行中修改 profile patch 后是否即时反映，未做界面确认。按 2026-11-18 的验收决定，此项不计入 0.3.2 验收；profile patch 属于启动期层，编辑文件不应默认热生效。
- **390px 精确档**：受应用最小窗宽限制（534px，内容区约 520px），只有静态 CSS 兜底；按验收决定不纳入 0.3.2 结论。

## 验收结论（0.3.2）

- **通过**：B4、B5（视觉由 B12 覆盖）、B6、B7、B8、B9、B10（配置层）、B12。
- **忽略**：B10 运行中热生效、390px 精确档（见上）。
- **已知非阻塞小问题**：Host 不持久化旧轮 summary；0.3.3 起客户端在 404 时把该轮视为过期并回到空态（不再显示旧轮/missing），但要看到具体改动仍需一轮新的写文件对话。`error` 状态对齐、`ready` 但 0 文件时的打开提示、`missing`/`error` 全渲染与滚动复位测试已在 0.3.3 修复。这些问题不影响 0.3.2 验收结论。

## 已知限制（重启后的 review 投影）

- DSH 重启后，客户端持久化的 `review-gate/changes` 投影可能仍指向重启前的轮次（本地复现为 turn 11 / seq 2291）；此时 Host 已不再提供该轮 summary。0.3.3 起客户端在 404 时把该轮视为过期并回到空态（不再显示旧轮或 missing 卡片）；底层投影值保留到下一次 `workspace/changes` 更新，但不再渲染为有效轮次。
- 恢复方式：跑一轮新的、会写文件的对话；空态会提示。

## 0.3.2 补充

- npm `0.3.2` 于 2026-11-17T15:20:20Z 发布（32 files；tarball 82,660 B，sha256 `986fbebd…`），修复上述 `missing` 状态 UI。
- `index.json` 加入 0.3.2（`publishTimestamp=1794928820`），官方解析器 PASS (versions=3)；[index-reachability run 44114301707](https://github.com/AiLunSin/dsh-review-gate/actions/runs/44114301707) PASS，raw 2,323 B / sha256 `7434b366…` 与仓库一致。
- tag `v0.3.2` 已推送；GitHub Release 已创建并上传 `ailunsin-dsh-review-gate-0.3.2.tgz`（82,660 B，digest `sha256:986fbebd…`）。Desktop profile 已安装 npm 0.3.2，重启后生效。

## 0.3.4 / 0.3.5 验证记录（2026-11-17 / 18）

### 0.3.3 与 0.3.4 发布

- **0.3.3**：tag 指向提交 `b78c535`；npm 于 2026-11-17T16:44:36Z 发布；`index.json` 的 `publishTimestamp=1794933876`。
- **0.3.4**：npm 于 2026-11-17T16:52:00.752Z 发布（latest），`index.json` 的 `publishTimestamp=1794934320`；tag 指向提交 `8379b02`，功能提交为 `cc7aa2b`；CI（8379b02）success；[index-reachability run 44131086045](https://github.com/AiLunSin/dsh-review-gate/actions/runs/44131086045) PASS。
- **GitHub Release**：`v0.3.4` 已发布，附件 `ailunsin-dsh-review-gate-0.3.4.tgz`，33 files、88,424 B。

### 0.3.4 快照验证（已执行）

1. 0.3.4 发布前测试为 `150/150` pass（151 是加入 0.3.5 prune 用例后的总数）。
2. 用打包后的 dist 做两进程“重启”模拟：
   - live 阶段：HTTP 200，快照文件 363 B；落盘内容不含 `content` / `hints` / `cwd` / `diff`。
   - restart 阶段：HTTP 200，响应头 `x-review-gate-snapshot: 1`，`stale:true`，`capturedAt` 存在；3 个文件 / 3 个审查单元完整还原，`hints` 为空。
3. 渲染级检查：
   - stale 状态显示快照提示，文件行 class 为 `rg-file rg-file-static`，无 `openHint`；
   - 正常轮次文件行为 `rg-file` 可点击，且有 `openHint`。

**未完成**：真实 DSH 重启后的 UI 实机记录**尚未采集**，不得视为已完成验证。

### 0.3.5（已发布）

- **修复**：`prune` 只匹配文件名 `^[0-9a-f]{16}-\d{10}\.json$` 的快照文件；`review.snapshot.dir` 指向共享目录时不再误删无关 JSON。新增测试断言 `keep.json` / `package.json` / 非补零命名文件不被删除。
- **提交**：`b1c3e80 fix: prune only review-gate snapshot files`。
- **测试/构建**：`151/151` pass；dist 0.3.5 已构建；`npm run smoke:install` PASS。
- **发布**：npm `0.3.5` 于 2026-11-17T17:11:43.649Z 发布（33 files，88,458 B）；`index.json` 的 `publishTimestamp=1794935503`，官方解析器 PASS（versions=6）；tag `v0.3.5` 与 GitHub Release 已完成；Desktop profile 已升级到 npm 0.3.5。
