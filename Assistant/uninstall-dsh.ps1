#Requires -Version 5.1
<#
.SYNOPSIS
  install-dsh.ps1 的对称卸载。按 marker 摘除 patch 块与 AGENTS.md 引导块，
  删除 skills 与 ~/.mem0-claude-dsh 运行时目录。

.PARAMETER PurgeData
  同时删除 mem0 数据目录 ~/.dsh/mem0（记忆缓冲/配置）。默认保留。

.PARAMETER DryRun
  只打印计划，不删除任何文件。
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [switch]$PurgeData,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Home2     = $env:USERPROFILE
$InstallDir   = Join-Path $Home2 '.mem0-claude-dsh'
$DshHome      = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $Home2 '.dsh' }
$AgentsHome   = if ($env:DSH_AGENTS_HOME) { $env:DSH_AGENTS_HOME } else { Join-Path $Home2 '.agents' }
$SkillsDir    = Join-Path $DshHome 'skills'
$PatchPath    = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"
$PluginDir    = Join-Path $DshHome "profiles\$Profile\plugins\mem0-dsh-bridge"
$CredPath     = Join-Path $DshHome '.credentials.yaml'
$AgentsMd     = Join-Path $AgentsHome 'AGENTS.md'
$DataDir      = Join-Path $DshHome 'mem0'

$PATCH_MARKER_BEGIN = '# mem0-claude-kit:dsh begin'
$PATCH_MARKER_END   = '# mem0-claude-kit:dsh end'
$AGENTS_MARKER_BEGIN = '<!-- mem0-dsh:begin'
$AGENTS_MARKER_END   = '<!-- mem0-dsh:end -->'

$SkillNames = @(
    'mem0-remember.md', 'mem0-search.md', 'mem0-forget.md', 'mem0-done.md',
    'mem0-status.md', 'mem0-pause.md', 'mem0-resume.md',
    'publish-project-docs.md', 'archive-docs.md', 'handoff.md', 'dsh-resume.md',
    'distill.md', 'distill-history.md'
)

function Write-Plan { param($msg) if ($DryRun) { Write-Host "[dryrun] $msg" -ForegroundColor Cyan } else { Write-Host $msg } }

Write-Host '== mem0-dsh 卸载 ==' -ForegroundColor Green
if ($DryRun) { Write-Host '（DryRun 模式：不删除任何文件）' -ForegroundColor Yellow }

# ---------- patch 块 ----------
if (Test-Path $PatchPath) {
    Write-Plan "1. 摘除 patch 块 → $PatchPath"
    if (-not $DryRun) {
        $existing = Get-Content $PatchPath -Raw -Encoding UTF8
        if ($existing -match [regex]::Escape($PATCH_MARKER_BEGIN)) {
            $pattern = "(?s)\r?\n?" + [regex]::Escape($PATCH_MARKER_BEGIN) + ".*?" + [regex]::Escape($PATCH_MARKER_END) + "\r?\n?"
            $merged = [regex]::Replace($existing, $pattern, '')
            Set-Content $PatchPath $merged -Encoding utf8 -NoNewline
        } else {
            Write-Host '   （未发现 marker 块，跳过）'
        }
    }
} else {
    Write-Plan "1. patch 文件不存在，跳过（$PatchPath）"
}

# ---------- skills ----------
Write-Plan '2. 删除 mem0 skills'
foreach ($s in $SkillNames) {
    $p = Join-Path $SkillsDir $s
    if (Test-Path $p) {
        Write-Plan "   - $s"
        if (-not $DryRun) { Remove-Item $p -Force -Confirm:$false }
    }
}

# ---------- AGENTS.md 块 ----------
if (Test-Path $AgentsMd) {
    Write-Plan "3. 摘除 AGENTS.md 引导块 → $AgentsMd"
    if (-not $DryRun) {
        $existing = Get-Content $AgentsMd -Raw -Encoding UTF8
        if ($existing -match [regex]::Escape($AGENTS_MARKER_BEGIN)) {
            $pattern = "(?s)\r?\n?" + [regex]::Escape($AGENTS_MARKER_BEGIN) + ".*?" + [regex]::Escape($AGENTS_MARKER_END) + "\r?\n?"
            $merged = [regex]::Replace($existing, $pattern, '')
            Set-Content $AgentsMd $merged -Encoding utf8 -NoNewline
        }
    }
} else {
    Write-Plan '3. AGENTS.md 不存在，跳过'
}

# ---------- 凭证条目 ----------
if (Test-Path $CredPath) {
    Write-Plan "4. 摘除凭证 MEM0_API_KEY → $CredPath"
    if (-not $DryRun) {
        $lines = @(Get-Content $CredPath) | Where-Object { $_ -notmatch '^\s*MEM0_API_KEY:' }
        Set-Content $CredPath ($lines -join "`r`n") -Encoding utf8
    }
}

# ---------- bridge 插件（profile 树内） ----------
Write-Plan "5a. 删除 bridge 插件目录 $PluginDir"
if (Test-Path $PluginDir) {
    if (-not $DryRun) { Remove-Item -Recurse -Force $PluginDir -Confirm:$false }
} else {
    Write-Plan '   （不存在，跳过）'
}

# ---------- 运行时目录 ----------
Write-Plan "5b. 删除运行时目录 $InstallDir（含 ui/ hooks/ tools/ original/ mcp/）"
if (Test-Path $InstallDir) {
    if (-not $DryRun) { Remove-Item -Recurse -Force $InstallDir -Confirm:$false }
} else {
    Write-Plan '   （不存在，跳过）'
}

# ---------- 数据目录（可选） ----------
if ($PurgeData) {
    Write-Plan "6. 删除 mem0 数据目录 $DataDir（-PurgeData）"
    if (Test-Path $DataDir) {
        if (-not $DryRun) { Remove-Item -Recurse -Force $DataDir -Confirm:$false }
    }
} else {
    Write-Plan "6. 保留 mem0 数据目录 $DataDir（加 -PurgeData 才删除）"
}

Write-Host ''
Write-Host '== 卸载完成 ==' -ForegroundColor Green
Write-Host '重启 dsh 后 patch/插件/skills 即全部失效。'
