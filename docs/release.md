# 发布手册（dsh-review-gate 0.3.4）

本文件记录三种发布形态（D4）的实际状态与命令。日期：2026-11-17（0.3.4 于 2026-11-17T16:52:00.752Z 发布）。

## 0. 当前状态

| 形态 | 状态 |
|---|---|
| GitHub 仓库 | 已推送 public 仓库 `https://github.com/AiLunSin/dsh-review-gate`；tag `v0.1.0` / `v0.2.0` / `v0.3.0` / `v0.3.1` / `v0.3.2` / `v0.3.3` / `v0.3.4` 已推送 |
| GitHub Release | `v0.3.0` / `v0.3.1` / `v0.3.2` / `v0.3.3` / `v0.3.4` 已发布；[v0.3.4](https://github.com/AiLunSin/dsh-review-gate/releases/tag/v0.3.4) 附 `ailunsin-dsh-review-gate-0.3.4.tgz`（33 files，88,424 B） |
| npm 包 | `@ailunsin/dsh-review-gate@0.3.4` 已发布（`latest=0.3.4`；33 files；88,424 B）；0.3.3 于 2026-11-17T16:44:36Z 发布 |
| CI | GitHub Actions 在 `main` 8379b02 上通过：`ci` success；`index-reachability` [run 44131086045](https://github.com/AiLunSin/dsh-review-gate/actions/runs/44131086045) PASS |
| 自建索引 | `index.json` 含 0.3.4；`publishTimestamp=1794934320`（2026-11-17T16:52:00.752Z，npm 实际发布时间） |
| 本地 Desktop profile | 已安装 npm `0.3.4`（`dsh plugin --profile desktop add @ailunsin/dsh-review-gate@0.3.4`，`dependencies` 已确认为 0.3.4；重启 DSH 生效） |

已确认的事实：

- npm 无 scope 名称 `dsh-review-gate` **已被无关项目占用**（0.2.0，post-turn code review），因此发布名固定为 `@ailunsin/dsh-review-gate`。
- `npm view @ailunsin/dsh-review-gate` 返回 `0.3.4`（latest）；0.3.0 含 P2 handler 调用 bug，0.3.1 修复；0.3.2 修复重启后 stale review 投影的 missing 状态；0.3.3 整理页签状态渲染；0.3.4 增加重启后的无正文快照。
- 本机 `npm whoami`：`ailunsin`。
- 本机没有 `gh` CLI；仓库已通过 git 推送，维护不需要 `gh`。
- 官方索引解析器校验通过：`plugins=1, versions=5`。
- 索引 raw URL 已由 GitHub Actions runner 验证（0.3.4 内容）：[index-reachability run 44131086045](https://github.com/AiLunSin/dsh-review-gate/actions/runs/44131086045) PASS：200 直出、无重定向，内容与仓库一致。本机到 raw 域名仍超时，这是本地链路问题。
- `v0.3.4` tag 指向提交 `8379b02`（功能提交 `cc7aa2b`）；tag 与 GitHub Release 已完成，Release 附件 `ailunsin-dsh-review-gate-0.3.4.tgz` 为 33 files、88,424 B。
- `v0.3.3` tag 指向提交 `b78c535`，npm 于 2026-11-17T16:44:36Z 发布，`index.json` 的 `publishTimestamp=1794933876`。
- `0.3.5` **尚未发布**；本地已修复 prune 并构建 dist，详见第 7 节。

## 1. 构建发布包

```powershell
cd C:\Users\11403\Desktop\one_too
node scripts/check-syntax.mjs
node --test "test/*.test.js"
node e2e/run.mjs                 # 需要 DSH_INSTALL_DIR / DSH_NODE_EXECUTABLE
node e2e/approval.mjs            # ask/reject + ask/allow 真实审批链路
node scripts/build-release.mjs --name @ailunsin/dsh-review-gate
node scripts/smoke-install.mjs   # manifest + npm pack + 临时 profile 安装
npm pack --dry-run --json        # 在 dist 目录内，确认文件清单
```

产物目录：`dist/ailunsin--dsh-review-gate/`。不要在仓库根直接 `npm publish`：根 `package.json` 已经是 scoped 名称，但发布文件清单、bundle patch 重写与 `npm pack` 结果应以构建产物为准。

生成 tarball：

```powershell
cd dist\ailunsin--dsh-review-gate
npm pack
# -> ailunsin-dsh-review-gate-0.3.4.tgz
```

已发布并验证：

- npm `0.3.4` 已发布（`latest=0.3.4`；33 files；88,424 B）。
- 用 `npm pack --dry-run --json` 核对 tarball 文件清单；发布包不含 `src/review-gate-e2e/` 测试夹具。
- 本地 `dist/` 可用 `npm run build:release` 重建。
- npm tarball 实装曾在全新 headless profile 验证（0.3.1）；Desktop profile 已升级到 npm `0.3.4`，重启后生效。

## 2. npm 发布（后续版本）

0.3.4 已完成；以下命令用于下一个版本（0.3.5，尚未发布）。

```powershell
npm login
npm whoami                        # 必须返回账号名
cd C:\Users\11403\Desktop\one_too\dist\ailunsin--dsh-review-gate
npm publish --access public
npm view @ailunsin/dsh-review-gate version dist-tags
```

2FA 开启时：

```powershell
npm publish --access public --otp <6 位 OTP>
```

或使用仓库内脚本（会先检查 dist 与登录态）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\publish-npm.ps1 -Version 0.3.5
```

发布后安装验证：

```powershell
# 新临时 profile 或用户 profile
dsh plugin add @ailunsin/dsh-review-gate@0.3.5
```

## 3. GitHub 发布

仓库：`https://github.com/AiLunSin/dsh-review-gate`（`main` 与 tag `v0.3.4` 已推送）。0.3.4 已完成（npm + GitHub Release 附件）；下一个版本沿用：

```powershell
git tag v0.3.5
git push origin main
git push origin v0.3.5
```

推送前确认：

```powershell
git status --short
git remote -v
```

`.github/workflows/ci.yml` 会在 push/PR 时跑 lint、单测、构建、索引结构校验；`.github/workflows/index-reachability.yml` 在 `main` 的 `index.json`/`icon.svg` 变更时由 GitHub runner 验证 raw 200 直出与内容一致。e2e 需要 DSH 安装，默认不跑。

## 4. 自建索引

文件：仓库根 `index.json`（格式 1）。发布到 GitHub 后，索引 URL 可用：

```text
https://raw.githubusercontent.com/AiLunSin/dsh-review-gate/main/index.json
```

注意：

- DSH 对索引 URL **严格按给定 URL 请求并拒绝重定向**；raw 必须 200 直出。仓库的 [index-reachability run 44131086045](https://github.com/AiLunSin/dsh-review-gate/actions/runs/44131086045) 已断言 0.3.4 内容 200 直出 + 内容一致；GitHub Pages 的最终地址同样不能跳转。
- `versions[].publishTimestamp` 是 **Unix 秒**（不是 ISO 字符串）；0.3.4 已使用 npm 实际发布时间 `1794934320`，后续版本发布后同样更新并重新校验。
- `icon` 是绝对 raw URL；索引解析器校验通过。
- 发布前重新验证：

```powershell
node scripts\validate-market-index.mjs
```

本机输出：`PASS official parser (plugins=1, versions=5)`。

## 5. 用户侧验证清单

1. 在 DSH **Plugins** 里看到 **Review gate** 行与图标。
2. 新会话执行 `/review-scope src/auth/**`，再让 Agent 写 `src/utils/x.ts` → 出现审批（或按 `never` 策略拒绝）。
3. 拒绝后 Agent 收到 `Error: [review-gate] ...`，会话继续。
4. 写范围内文件 → 静默成功。
5. `$DSH_HOME/review-gate/audit/audit-YYYY-MM-DD.jsonl` 出现决策行，且不含文件正文。
6. 停用插件 → `/review-scope` 消失、无残留报错。

## 6. 发布后（0.1.1+）升级约定

- 每次 DSH 发版后先跑 `node e2e/run.mjs`，再同步 `engines.dsh`（当前精确锁定 `0.2.2-rc.3`）。
- 契约字段变更必须发 minor 并更新 README/限制；只改规则/文档可发 patch。

## 7. 0.3.5（待发布）

> **状态：尚未发布。** 0.3.5 只在本地完成修复、构建与验证；npm、GitHub tag/Release 与 `index.json` 均未更新。

- **修复**：`prune` 原先按任意 `.json` 筛选，并在超过 20 个时删除最旧文件；当 `review.snapshot.dir` 指向共享/项目目录时，可能误删无关 JSON。现在只匹配文件名 `^[0-9a-f]{16}-\d{10}\.json$` 的快照文件，其它文件不计入上限、也不会被删除。
- **提交**：`b1c3e80 fix: prune only review-gate snapshot files`。
- **测试/构建**：`151/151` tests pass；本地已构建 dist 0.3.5；`npm run smoke:install` PASS。
- **发布命令**：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-npm.ps1 -Version 0.3.5
```

- **发布后待办**：
  1. 记录 npm 实际发布时间，并把 `index.json` 的 `versions[].publishTimestamp` 更新为 Unix 秒；
  2. 推送 tag `v0.3.5`；
  3. 创建 GitHub Release 并上传 `ailunsin-dsh-review-gate-0.3.5.tgz`；
  4. 升级本地 Desktop profile 到 0.3.5 并记录验证结果。
