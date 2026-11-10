#Requires -Version 5.1
<#
.SYNOPSIS
  一键启动 deepseek-harness Web UI（含 mem0-dsh-bridge 插件）。

.DESCRIPTION
  从仓库源码启动 `pnpm start:web`。mem0-dsh-bridge 以 .ts 源码挂载，
  因此必须用源码启动；`npx @deepseek-ai/dsh` 的打包版加载不了它。

  启动前检查：仓库位置、Node >= 24.9、pnpm、node_modules、端口占用。
  日志写入 ~/.mem0-claude-dsh/logs/dsh-web-<时间>.log。

.PARAMETER Port
  Web UI 端口，默认 3080。

.PARAMETER NoOpen
  不自动打开浏览器。

.PARAMETER Install
  node_modules 缺失时自动执行 pnpm install（首次较慢）。

.PARAMETER Check
  只做环境检查，不启动服务。

.EXAMPLE
  .\start-dsh.ps1
  .\start-dsh.ps1 -Port 3081 -NoOpen
  .\start-dsh.ps1 -Check
#>
[CmdletBinding()]
param(
    [int]$Port = 3080,
    [switch]$NoOpen,
    [switch]$Install,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step { param([string]$Message) Write-Host "[start-dsh] $Message" -ForegroundColor Cyan }
function Stop-WithError { param([string]$Message) Write-Host "[start-dsh] $Message" -ForegroundColor Red; exit 1 }

# ---------- 1. 仓库结构 ----------
$cliEntry = Join-Path $RepoRoot 'apps\cli\src\bin.ts'
if (-not (Test-Path $cliEntry)) {
    Stop-WithError "这不是 deepseek-harness 仓库（找不到 apps\cli\src\bin.ts）：$RepoRoot"
}

# ---------- 2. Node >= 24.9 ----------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Stop-WithError '未找到 node。请安装 Node.js 24.9+ 后重试。' }
$nodeVersion = (& node -p "process.versions.node" 2>$null | Select-Object -First 1)
$parts = "$nodeVersion".Split('.')
$nodeOk = $false
if ($parts.Count -ge 2) {
    $maj = [int]$parts[0]
    $min = [int]$parts[1]
    $nodeOk = ($maj -gt 24) -or ($maj -eq 24 -and $min -ge 9)
}
if (-not $nodeOk) { Stop-WithError "Node $nodeVersion 太旧，需要 >= 24.9.0。" }
Write-Step "Node $nodeVersion"

# ---------- 3. pnpm ----------
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCmd) {
    Stop-WithError '未找到 pnpm。请先安装 pnpm 11.x（corepack enable，或 npm i -g pnpm）。'
}

# ---------- 4. 依赖 ----------
if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    if ($Install) {
        Write-Step '缺少 node_modules，执行 pnpm install（首次较慢）...'
        Push-Location $RepoRoot
        try {
            & pnpm install
            if ($LASTEXITCODE -ne 0) { Stop-WithError "pnpm install 失败（exit $LASTEXITCODE）。" }
        } finally { Pop-Location }
    } else {
        Stop-WithError '缺少 node_modules。先运行 pnpm install，或加 -Install 让本脚本自动安装。'
    }
}

# ---------- 5. 端口 ----------
try {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
} catch {
    $listener = $null
}
if ($listener) {
    Stop-WithError "端口 $Port 已被 PID $($listener.OwningProcess) 占用；换一个端口：-Port 3081"
}

# ---------- 6. mem0 桥是否已安装（只告警，不阻塞） ----------
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
$bridgeInstalled = (Test-Path $patch) -and (Select-String -Path $patch -Pattern 'mem0-dsh-bridge' -Quiet)
if (-not $bridgeInstalled) {
    Write-Warning '未检测到 mem0-dsh-bridge 的 profile 安装：网页能启动，但 mem0 记忆桥不会加载。先运行 Assistant\install-dsh.ps1。'
}

if ($Check) {
    Write-Step "环境检查通过：$RepoRoot"
    exit 0
}

# ---------- 7. 日志 + 启动 ----------
$logDir = Join-Path $env:USERPROFILE '.mem0-claude-dsh\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$logPath = Join-Path $logDir ('dsh-web-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

Write-Step "启动 dsh Web：http://127.0.0.1:$Port"
Write-Step "日志：$logPath"
Write-Step '按 Ctrl+C 停止。'

Push-Location $RepoRoot
$previousEap = $ErrorActionPreference
try {
    # 经 cmd 合并 stderr 后再交给 Tee：PS 5.1 若直接 `2>&1` 原生命令，
    # 会把 pnpm 的命令回显包装成红色 NativeCommandError，日志也会变脏。
    $commandLine = "pnpm start:web --port $Port"
    if ($NoOpen) { $commandLine += ' --no-open' }
    $commandLine += ' 2>&1'
    $ErrorActionPreference = 'Continue'
    & cmd.exe /d /c $commandLine | Tee-Object -FilePath $logPath
    $code = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousEap
    Pop-Location
}
exit $code
