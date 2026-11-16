# 发布手册（dsh-review-gate 0.2.0）

本文件记录三种发布形态（D4）的实际状态、命令与当前阻塞项。日期：2026-11-17。

## 0. 当前状态

| 形态 | 状态 | 阻塞 |
|---|---|---|
| GitHub 仓库 | 本地 git 已初始化；远程仓库不存在 | 本机没有 `gh`，也没有可推送凭据；需账号持有人创建仓库或提供凭据 |
| npm 包 | `dist/` 产物与 tarball 已生成；`npm pack` / 临时 profile 安装通过；本机 Desktop profile 已安装 0.2.0 并通过 Client Inspect 确认页签 body 注册 | `npm whoami` 返回 **E401**；需账号持有人 `npm login`（含 2FA/OTP） |
| 自建索引 | `index.json` 已生成并通过官方 `parseMarketIndex` 校验 | 索引 URL 依赖 GitHub raw/Pages；需先完成 GitHub 发布 |

已确认的事实：

- npm 无 scope 名称 `dsh-review-gate` **已被无关项目占用**（0.2.0，post-turn code review），因此发布名固定为 `@ailunsin/dsh-review-gate`。
- `npm view @ailunsin/dsh-review-gate` 返回 404，名称可用。
- 本机 `npm whoami`：`E401 Unauthorized`。
- 本机没有 `gh` CLI；`git ls-remote https://github.com/AiLunSin/dsh-review-gate.git` 返回 "Repository not found"。
- 官方索引解析器校验通过：`plugins=1, versions=1`。

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
# -> ailunsin-dsh-review-gate-0.2.0.tgz
```

本机已生成并验证：

- `dist/ailunsin--dsh-review-gate/ailunsin-dsh-review-gate-0.2.0.tgz`
- 用该 tarball 向临时 headless profile `plugin add` 成功，`--dump-config` 含 `@ailunsin/dsh-review-gate` 与 `id: review-gate`。
- 本机 Desktop profile 安装 0.2.0：`application: applied`；Client Inspect 的 `sidebar.right.pane.tab` occupants 含 `@ailunsin/dsh-review-gate`（active）。

## 2. npm 发布（需账号持有人）

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
powershell -ExecutionPolicy Bypass -File scripts\publish-npm.ps1 -Version 0.2.0
```

发布后安装验证：

```powershell
# 新临时 profile 或用户 profile
dsh plugin add @ailunsin/dsh-review-gate@0.2.0
```

## 3. GitHub 发布

仓库目标：`https://github.com/AiLunSin/dsh-review-gate`。

当前本地仓库已提交（见 `git log`），但没有远程。账号持有人任选其一：

```powershell
# 有 gh 时
gh repo create AiLunSin/dsh-review-gate --public --source . --remote origin --push

# 或先在网页创建空仓库，再
git remote add origin https://github.com/AiLunSin/dsh-review-gate.git
git push -u origin main
git tag v0.2.0
git push origin v0.2.0
```

推送前确认：

```powershell
git status --short
git remote -v
```

`.github/workflows/ci.yml` 会在 push/PR 时跑 lint、单测、构建、索引结构校验；e2e 需要 DSH 安装，默认不跑（可用手动 workflow 或本机执行）。

## 4. 自建索引

文件：仓库根 `index.json`（格式 1）。发布到 GitHub 后，索引 URL 可用：

```text
https://raw.githubusercontent.com/AiLunSin/dsh-review-gate/main/index.json
```

注意：

- DSH 对索引 URL **严格按给定 URL 请求并拒绝重定向**；raw.githubusercontent.com 是 200 直出，可用。若用 GitHub Pages，请确认最终地址不跳转。
- `versions[].publishTimestamp` 是 **Unix 秒**（不是 ISO 字符串）；npm 发布后把 `scripts` 中的占位时间改成实际发布时间再提交。
- `icon` 是绝对 raw URL；索引解析器校验通过。
- 发布前重新验证：

```powershell
node scripts\validate-market-index.mjs
```

本机输出：`PASS official parser (plugins=1, versions=1)`。

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
