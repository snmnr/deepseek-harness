#Requires -Version 5.1
<#
.SYNOPSIS
  dsh + mem0 桥自检：构建产物、profile 挂载、状态文件、缓冲、端口、启动日志。

.DESCRIPTION
  只读检查，不修改任何文件。用于回答“网页打开了但 mem0 面板灰着/没有记忆”这类问题。
  需要更深入时加 -Deep，会调用 mem0_hooks_dsh.py doctor（会访问 mem0 服务）。

.EXAMPLE
  .\doctor-dsh.ps1
  .\doctor-dsh.ps1 -Deep
#>
[CmdletBinding()]
param(
    [switch]$Deep
)

$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$InstallDir = Join-Path $env:USERPROFILE '.mem0-claude-dsh'
$script:problems = @()
$listener = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$dshRunning = $null -ne $listener

function Section([string]$Title) { Write-Host "`n== $Title ==" -ForegroundColor Cyan }
function Ok([string]$Message) { Write-Host "  OK    $Message" -ForegroundColor Green }
function Warn([string]$Message) { Write-Host "  WARN  $Message" -ForegroundColor Yellow; $script:problems += $Message }
function Fail([string]$Message) { Write-Host "  FAIL  $Message" -ForegroundColor Red; $script:problems += $Message }

Section '仓库与环境'
Write-Host "  repo:  $RepoRoot"
Write-Host "  dsh:   $DshHome"
Write-Host "  node:  " + (& node --version 2>$null)
Write-Host "  pnpm:  " + (& pnpm --version 2>$null)

Section '依赖与构建产物（缺任意一项，dsh 会启动失败或 bridge 不加载）'
$markers = [ordered]@{
    'schemastery (依赖)'       = (Join-Path $RepoRoot 'apps\cli\node_modules\@deepseek-ai\schemastery\lib\index.cjs')
    'client bundle'           = (Join-Path $RepoRoot 'packages\api\gateway\lib\client.browser.js')
    'typert loader'           = (Join-Path $RepoRoot 'packages\typert\loader\lib')
    'app-boot lib'            = (Join-Path $RepoRoot 'packages\boot\app-boot\lib')
    'dsh-commands typert'     = (Join-Path $RepoRoot 'packages\bundle\base\node_modules\@deepseek-ai\dsh-commands\lib\typert.host.js')
    'dsh-goal typert'         = (Join-Path $RepoRoot 'apps\cli\node_modules\@deepseek-ai\dsh-goal\lib\typert.host.js')
}
foreach ($item in $markers.GetEnumerator()) {
    if (Test-Path $item.Value) { Ok $item.Key } else { Fail "$($item.Key)：缺少 $($item.Value)" }
}

Section 'mem0 运行时（~/.mem0-claude-dsh）'
$hooks = Join-Path $InstallDir 'hooks\mem0_hooks_dsh.py'
$original = Join-Path $InstallDir 'original\mem0_hooks.py'
$versionFile = Join-Path $InstallDir 'original\VERSION'
if (Test-Path $hooks) { Ok "包装层：$hooks" } else { Fail "包装层缺失：$hooks" }
if (Test-Path $original) { Ok "原脚本：$original" } else { Fail "原脚本缺失：$original" }
if (Test-Path $versionFile) { Ok ("套件版本：" + (Get-Content $versionFile -Raw).Trim()) } else { Warn '缺少 original\VERSION（doctor 无法显示版本）' }

Section 'profile 挂载'
$patch = Join-Path $DshHome 'profiles\web\cordis.patch.yml'
if (Test-Path $patch) {
    $bridgeLine = Select-String -Path $patch -Pattern 'mem0-dsh-bridge' -SimpleMatch | Select-Object -First 1
    if ($bridgeLine) { Ok "patch 含 mem0-dsh-bridge（第 $($bridgeLine.LineNumber) 行）" } else { Fail "patch 未包含 mem0-dsh-bridge：$patch" }
} else {
    Fail "profile patch 缺失：$patch"
}
$pluginEntry = Join-Path $DshHome 'profiles\web\plugins\mem0-dsh-bridge\src\index.ts'
if (Test-Path $pluginEntry) { Ok "bridge 插件：$pluginEntry" } else { Fail "bridge 插件未安装：$pluginEntry" }

Section 'bridge 激活心跳'
$heartbeat = Join-Path $DshHome 'mem0\bridge-alive.json'
if (Test-Path $heartbeat) {
    try {
        $hb = Get-Content $heartbeat -Raw -Encoding UTF8 | ConvertFrom-Json
        $hbAt = [datetime]$hb.at
        $ageMin = [int]((Get-Date).ToUniversalTime() - $hbAt.ToUniversalTime()).TotalMinutes
        Ok "bridge 已激活：PID $($hb.pid)，心跳 $($hb.at)（$ageMin 分钟前）"
        if ($dshRunning -and $ageMin -gt 10) {
            Warn "心跳已 $ageMin 分钟未更新：bridge 可能卡住或进程已停止响应"
        }
    } catch {
        Warn "bridge-alive.json 无法解析：$heartbeat"
    }
} elseif ($dshRunning) {
    Warn '没有 bridge-alive.json：mem0-dsh-bridge 未激活（看启动日志的 failed to import）'
} else {
    Write-Host '  INFO  dsh 未运行，尚无心跳属正常'
}

Section '会话数据与状态文件'
$buffers = @(Get-ChildItem (Join-Path $DshHome 'mem0') -Filter 'buffer_*.json' -ErrorAction SilentlyContinue)
if ($buffers.Count -gt 0) {
    Ok "缓冲文件 $($buffers.Count) 个（bridge 在采集）"
    $buffers | Sort-Object LastWriteTime -Descending | Select-Object -First 5 |
        ForEach-Object { Write-Host "        $($_.Name)  $($_.Length) B  $($_.LastWriteTime)" }
} elseif ($dshRunning) {
    Warn '没有 buffer_*.json：bridge 没有采集任何事件（可能插件未加载，或尚未发生会话事件）'
} else {
    Write-Host '  INFO  dsh 未运行，尚无 buffer 属正常（启动并发一条消息后再看）'
}

$statusCandidates = @(
    (Join-Path $RepoRoot 'notes\_state\mem0-status.json'),
    (Join-Path $DshHome 'state\mem0\mem0-status.json')
)
foreach ($p in $statusCandidates) {
    if (Test-Path $p) { Ok "状态文件：$p  $((Get-Item $p).LastWriteTime)" }
}
$docStatus = @(Get-ChildItem (Join-Path $env:USERPROFILE 'Documents') -Recurse -Filter 'mem0-status.json' -Depth 5 -ErrorAction SilentlyContinue |
    Select-Object -First 3)
foreach ($f in $docStatus) { Ok "Documents 下的状态文件：$($f.FullName)  $($f.LastWriteTime)" }
if (($statusCandidates | Where-Object { Test-Path $_ }).Count -eq 0 -and $docStatus.Count -eq 0) {
    if ($dshRunning) {
        Warn '没有找到 mem0-status.json：UI 面板会显示“状态文件不可读”'
    } else {
        Write-Host '  INFO  dsh 未运行，尚无状态文件属正常（首个 turn 边界后写入）'
    }
}

Section '3080 端口'
if ($listener) {
    $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) {
        Ok "监听 3080：PID $($proc.Id) $($proc.ProcessName)，启动于 $($proc.StartTime)"
    } else {
        Ok "监听 3080：PID $($listener.OwningProcess)（进程信息不可读）"
    }
} else {
    Write-Host '  INFO  3080 当前没有监听：dsh 未运行，先启动 start-dsh.ps1'
}

Section '最近的启动日志（只列关键行）'
$startup = Get-ChildItem (Join-Path $DshHome 'logs') -Filter 'startup-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$buildTimes = @($markers.Values | Where-Object { Test-Path $_ } | ForEach-Object { (Get-Item $_).LastWriteTime })
$buildTime = ($buildTimes | Measure-Object -Maximum).Maximum
if ($startup) {
    Write-Host "  文件：$($startup.FullName)"
    Write-Host "  时间：$($startup.LastWriteTime)"
    if ($buildTime -and $startup.LastWriteTime -lt $buildTime) {
        Write-Host "  STALE 该日志早于最近构建（$buildTime），可能来自构建前的旧启动；请以新启动日志为准" -ForegroundColor Yellow
    }
    $hits = Select-String -Path $startup.FullName -Pattern 'startup failed|plugin did not activate|failed to import|typert|client bundle|client-modules|mem0-dsh-bridge|dsh web:' -ErrorAction SilentlyContinue |
        Select-Object -Last 20
    if ($hits) {
        $hits | ForEach-Object { Write-Host ("    " + $_.Line.Trim()) }
    } else {
        Ok '没有匹配到错误关键字'
    }
} else {
    if ($dshRunning) { Warn '没有 startup-*.log' } else { Write-Host '  INFO  dsh 未运行，还没有新的启动日志' }
}

if ($Deep -and (Test-Path $hooks)) {
    Section 'mem0 doctor（会访问服务端）'
    & python $hooks doctor
}

Section '结论'
if ($script:problems.Count -eq 0) {
    Write-Host '  未发现明显问题。' -ForegroundColor Green
} else {
    Write-Host "  发现 $($script:problems.Count) 个问题：" -ForegroundColor Yellow
    $script:problems | ForEach-Object { Write-Host "   - $_" }
    Write-Host ''
    Write-Host '  常见处理：'
    Write-Host '   - 缺依赖/构建产物：pnpm install; pnpm run build，然后重启 start-dsh.ps1'
    Write-Host '   - patch/插件缺失：重跑 install-dsh.cmd -KitDir "$env:USERPROFILE\.mem0-claude" -ReuseClaudeConfig'
    Write-Host '   - 有 buffer 但面板灰：把 dsh 工作区切到项目根目录，再开新会话'
    Write-Host '   - 3080 被旧进程占用：确认是 dsh 后停掉，再重新启动'
}
