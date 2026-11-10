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
  强制重新执行 pnpm install（修复依赖）。默认只在 node_modules 缺失时安装。

.PARAMETER Build
  强制重新执行 pnpm run build。

.PARAMETER SkipBuild
  缺构建产物时不自动构建（仅排查用；dsh 会报 client bundle / typert not found）。

.PARAMETER NoBootstrap
  不自动补齐环境：缺 pnpm、缺 node_modules 时直接报错退出。

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
    [switch]$Build,
    [switch]$SkipBuild,
    [switch]$NoBootstrap,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step { param([string]$Message) Write-Host "[start-dsh] $Message" -ForegroundColor Cyan }
function Stop-WithError { param([string]$Message) Write-Host "[start-dsh] $Message" -ForegroundColor Red; exit 1 }

# 双击启动时 Explorer 可能还在用旧的 PATH（刚装完 Node/npm 没重启资源管理器），
# 所以不能只信 Get-Command：同时查常见安装位置，并把所在目录补进本进程 PATH。
function Find-Executable {
    param([string]$Name, [string[]]$Candidates)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Add-ToProcessPath {
    param([string]$Directory)
    if (-not $Directory) { return }
    if (($env:Path -split ';') -notcontains $Directory) {
        $env:Path = "$Directory;$env:Path"
    }
}

# ---------- 1. 仓库结构 ----------
$cliEntry = Join-Path $RepoRoot 'apps\cli\src\bin.ts'
if (-not (Test-Path $cliEntry)) {
    Stop-WithError "这不是 deepseek-harness 仓库（找不到 apps\cli\src\bin.ts）：$RepoRoot"
}

# ---------- 2. Node 24.9+ ----------
$nodePath = Find-Executable 'node' @(
    'C:\Program Files\nodejs\node.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe')
)
if (-not $nodePath) {
    Stop-WithError ('未找到 Node.js。请安装 Node.js 24.9+：' +
        'winget install OpenJS.NodeJS.LTS（装完重开本窗口）')
}
Add-ToProcessPath (Split-Path -Parent $nodePath)
$nodeVersion = (& $nodePath -p "process.versions.node" 2>$null | Select-Object -First 1)
$parts = "$nodeVersion".Split('.')
$nodeOk = $false
if ($parts.Count -ge 2) {
    $maj = [int]$parts[0]
    $min = [int]$parts[1]
    $nodeOk = ($maj -gt 24) -or ($maj -eq 24 -and $min -ge 9)
}
if (-not $nodeOk) { Stop-WithError "Node $nodeVersion 太旧，需要 >= 24.9.0。" }
Write-Step "Node $nodeVersion"

# ---------- 3. pnpm（缺失时自动安装） ----------
function Find-Pnpm {
    $found = Find-Executable 'pnpm' @(
        (Join-Path $env:APPDATA 'npm\pnpm.cmd'),
        (Join-Path $env:LOCALAPPDATA 'pnpm\pnpm.exe'),
        'C:\Program Files\nodejs\pnpm.cmd'
    )
    # cmd.exe 启动需要 .cmd/.exe；Get-Command 可能先找到 pnpm.ps1
    if ($found -and $found -match '\.ps1$') {
        $cmdVariant = [IO.Path]::ChangeExtension($found, '.cmd')
        if (Test-Path -LiteralPath $cmdVariant) { return $cmdVariant }
    }
    return $found
}

$pnpmPath = Find-Pnpm
if (-not $pnpmPath) {
    if ($NoBootstrap) {
        Stop-WithError '未找到 pnpm（已指定 -NoBootstrap）。请先 npm i -g pnpm@11。'
    }
    $npmPath = Find-Executable 'npm' @(
        'C:\Program Files\nodejs\npm.cmd',
        (Join-Path $env:ProgramFiles 'nodejs\npm.cmd')
    )
    if (-not $npmPath) {
        Stop-WithError '未找到 pnpm，也找不到 npm，无法自动安装。请重装 Node.js 24.9+。'
    }
    Write-Step '未找到 pnpm，自动安装 pnpm@11.28.5（npm install -g，可能需要几十秒）...'
    & $npmPath install -g 'pnpm@11.28.5'
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "pnpm 自动安装失败（exit $LASTEXITCODE）。请手动运行：npm i -g pnpm@11"
    }
    $pnpmPath = Find-Pnpm
    if (-not $pnpmPath) {
        Stop-WithError 'pnpm 安装后仍未找到。请重开本窗口，或确认 %APPDATA%\npm 在 PATH 中。'
    }
}
Add-ToProcessPath (Split-Path -Parent $pnpmPath)
$pnpmVersion = (& $pnpmPath --version 2>$null | Select-Object -First 1)
Write-Step "pnpm $pnpmVersion"

# ---------- 4. 依赖（缺失或不完整时自动安装） ----------
$nodeModules = Join-Path $RepoRoot 'node_modules'
# 只判断 node_modules 是否存在不够：半装/复制来的目录会缺 pnpm 链接，
# 启动时报 Cannot find module .../schemastery/lib/index.cjs。
$depsMarker = Join-Path $RepoRoot 'apps\cli\node_modules\@deepseek-ai\schemastery\lib\index.cjs'
$needInstall = $Install -or (-not (Test-Path $nodeModules)) -or (-not (Test-Path $depsMarker))
if ($needInstall) {
    if ($NoBootstrap -and ((-not (Test-Path $nodeModules)) -or (-not (Test-Path $depsMarker)))) {
        Stop-WithError '依赖缺失或不完整（已指定 -NoBootstrap）。请先运行 pnpm install。'
    }
    Write-Step '执行 pnpm install（补齐依赖；首次较慢，可能几分钟）...'
    Push-Location $RepoRoot
    try {
        & $pnpmPath install
        $installCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($installCode -ne 0) { Stop-WithError "pnpm install 失败（exit $installCode）。" }
    if (-not (Test-Path $depsMarker)) {
        Stop-WithError "pnpm install 后仍缺少 $depsMarker"
    }
}

# ---------- 4b. dsh 构建产物 ----------
# dsh 启动需要 lib/*.js（typert.host.js、client.js 等）；只装依赖不构建会报
# "client bundle not found" / "Cannot find module .../lib/typert.host.js"。
$buildMarkers = @(
    (Join-Path $RepoRoot 'packages\api\gateway\lib\client.browser.js'),
    (Join-Path $RepoRoot 'packages\typert\loader\lib'),
    (Join-Path $RepoRoot 'packages\boot\app-boot\lib'),
    (Join-Path $RepoRoot 'packages\bundle\base\node_modules\@deepseek-ai\dsh-commands\lib\typert.host.js'),
    (Join-Path $RepoRoot 'apps\cli\node_modules\@deepseek-ai\dsh-goal\lib\typert.host.js')
)
$missingMarkers = @($buildMarkers | Where-Object { -not (Test-Path $_) })
if ($Build -or $missingMarkers.Count -gt 0) {
    if ($Check) {
        Write-Step "缺少构建产物：$($missingMarkers -join ', ')"
        Write-Step '运行 .\Assistant\start-dsh.ps1（不带 -Check）会自动执行 pnpm run build'
        exit 1
    }
    if ($SkipBuild) {
        Write-Warning "缺少构建产物（-SkipBuild）：$($missingMarkers -join ', ')"
    } else {
        Write-Step '缺少构建产物，执行 pnpm run build（首次可能 5~15 分钟）...'
        Push-Location $RepoRoot
        try {
            & $pnpmPath run build
            $buildCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($buildCode -ne 0) { Stop-WithError "pnpm run build 失败（exit $buildCode）。" }
        $stillMissing = @($buildMarkers | Where-Object { -not (Test-Path $_) })
        if ($stillMissing.Count -gt 0) {
            Stop-WithError "构建后仍缺少：$($stillMissing -join ', ')"
        }
        Write-Step '构建完成'
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
    $commandLine = '"' + $pnpmPath + '" start:web --port ' + $Port
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
