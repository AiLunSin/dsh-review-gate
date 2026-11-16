param(
  [string]$Version = '0.3.0',
  [string]$Otp = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist\ailunsin--dsh-review-gate'
$manifest = Join-Path $dist 'package.json'

if (-not (Test-Path $manifest)) {
  throw "缺少发布产物 $dist。先运行 node scripts\build-release.mjs --name @ailunsin/dsh-review-gate"
}

$pkg = Get-Content $manifest -Raw | ConvertFrom-Json
if ($pkg.name -ne '@ailunsin/dsh-review-gate') { throw "包名不是 @ailunsin/dsh-review-gate：$($pkg.name)" }
if ($pkg.version -ne $Version) { throw "产物版本 $($pkg.version) 与请求版本 $Version 不一致" }

Write-Host '检查 npm 登录态...'
$who = (& npm.cmd whoami 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($who) -or $who -match 'E401|Unauthorized') {
  Write-Host "npm 未登录或凭据过期。请先运行：npm login" -ForegroundColor Yellow
  Write-Host "当前 whoami 输出：$who" -ForegroundColor Yellow
  exit 1
}
Write-Host "已登录 npm 账号：$who"

Push-Location $dist
try {
  if ([string]::IsNullOrWhiteSpace($Otp)) {
    & npm.cmd publish --access public
  } else {
    & npm.cmd publish --access public --otp $Otp
  }
  if ($LASTEXITCODE -ne 0) { throw "npm publish 失败（exit $LASTEXITCODE）" }
} finally {
  Pop-Location
}

Write-Host "发布后验证：npm view @ailunsin/dsh-review-gate@$Version version" -ForegroundColor Green
