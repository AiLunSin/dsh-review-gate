# 0.3.1 验证记录（2026-11-17）

本文件记录 0.3.0 P2 路由 bug 的修复与 0.3.1 发布相关的实际验证结果，供下一个版本回归时对照。

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
- **测试**：`138/138` pass，`npm run lint` 通过（43 JS + 4 JSON）。

## 未闭环

- **B5 视觉**：导入图/目录标签的浏览器肉眼确认未做，只有数据层与客户端代码路径证据。
- **B8–B10、B12**：浅/深色与窄栏、fresh-start 激活、配置覆盖即时生效、真实大轮次未人工验收。
