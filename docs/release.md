# 发布手册（dsh-review-gate 0.3.1）

本文件记录三种发布形态（D4）的实际状态与命令。日期：2026-11-17。

## 0. 当前状态

| 形态 | 状态 |
|---|---|
| GitHub 仓库 | 已推送 public 仓库 `https://github.com/AiLunSin/dsh-review-gate`；tag `v0.1.0` / `v0.2.0` / `v0.3.0` / `v0.3.1` 已推送 |
| GitHub Release | `v0.3.0` / `v0.3.1` 已发布；v0.3.1 附 `ailunsin-dsh-review-gate-0.3.1.tgz`（80,178 B，sha256 `cc8874e5…`） |
| npm 包 | `@ailunsin/dsh-review-gate@0.3.1` 已发布（`latest=0.3.1`；31 files） |
| CI | GitHub Actions 在 `main` 上通过：`ci`（lint、单测、构建、索引结构校验）与 `index-reachability`（raw 200 直出 + 内容一致） |
| 自建索引 | `index.json` 含 0.3.1；`publishTimestamp=1794896317`（2026-11-17T06:18:37Z，npm 实际发布时间） |
| 本地 Desktop profile | junction 到本地 `dist/ailunsin--dsh-review-gate`（0.3.1），用于开发验证，与 npm tarball 独立 |

已确认的事实：

- npm 无 scope 名称 `dsh-review-gate` **已被无关项目占用**（0.2.0，post-turn code review），因此发布名固定为 `@ailunsin/dsh-review-gate`。
- `npm view @ailunsin/dsh-review-gate` 返回 `0.3.1`（latest）；0.3.0 含 P2 handler 调用 bug，0.3.1 修复。
- 本机 `npm whoami`：`ailunsin`。
- 本机没有 `gh` CLI；仓库已通过 git 推送，维护不需要 `gh`。
- 官方索引解析器校验通过：`plugins=1, versions=2`。
- 索引 raw URL 已由 GitHub Actions runner 验证：[index-reachability run 44072294082](https://github.com/AiLunSin/dsh-review-gate/actions/runs/44072294082) PASS：200 直出、无重定向，`index.json` 2,102 B / sha256 `48558004015baac33e6cd3e8e1c64c1f8aa1ea21dd07dbbc7fb89b62c1c2aceb` 与仓库一致，`icon.svg` 200 且为 SVG。本机到 raw 域名仍超时，这是本地链路问题，不影响其他用户。
- 本地 `main` 已与 `origin/main` 一致（`c47a9da`）；`v0.3.1` tag 已推送，Release 已创建并上传 tarball 附件。

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
# -> ailunsin-dsh-review-gate-0.3.1.tgz
```

已发布并验证：

- npm `0.3.1` 已发布（`latest=0.3.1`；31 files）。
- 发布 tarball 内 `REVIEW_UNITS_ROUTE` 为 `/api/review-gate.units`，`handleReviewRequest({ ctx, config, request })` 为修复版，不含 `src/review-gate-e2e/` 测试夹具。
- 本地 `dist/` 可用 `npm run build:release` 重建；用 `npm pack --dry-run --json` 核对文件清单。
- 本机 Desktop profile 的 0.3.1 是 junction 到本地 `dist/` 的开发安装；npm tarball 实装已在全新 headless profile 验证：`dsh plugin add @ailunsin/dsh-review-gate@0.3.1` 成功，`--dump-config` 含 `id: review-gate`，`plugin remove` 后无残留行。

## 2. npm 发布（后续版本）

0.3.1 已完成；以下命令用于下一个版本。

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
powershell -ExecutionPolicy Bypass -File scripts\publish-npm.ps1 -Version 0.3.2
```

发布后安装验证：

```powershell
# 新临时 profile 或用户 profile
dsh plugin add @ailunsin/dsh-review-gate@0.3.1
```

## 3. GitHub 发布

仓库：`https://github.com/AiLunSin/dsh-review-gate`（`main` 与 tag `v0.3.1` 已推送）。0.3.1 已完成（npm 包 + Release 附件）；下一个版本沿用：

```powershell
git tag v0.3.2
git push origin main
git push origin v0.3.2
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

- DSH 对索引 URL **严格按给定 URL 请求并拒绝重定向**；raw 必须 200 直出。仓库的 [index-reachability run 44072294082](https://github.com/AiLunSin/dsh-review-gate/actions/runs/44072294082) 已断言 200 直出 + 内容一致；GitHub Pages 的最终地址同样不能跳转。
- `versions[].publishTimestamp` 是 **Unix 秒**（不是 ISO 字符串）；0.3.1 已使用 npm 实际发布时间 `1794896317`，后续版本发布后同样更新并重新校验。
- `icon` 是绝对 raw URL；索引解析器校验通过。
- 发布前重新验证：

```powershell
node scripts\validate-market-index.mjs
```

本机输出：`PASS official parser (plugins=1, versions=2)`。

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
