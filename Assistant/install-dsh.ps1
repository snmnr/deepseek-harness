#Requires -Version 5.1
<#
.SYNOPSIS
  mem0-claude-kit → deepseek-harness (dsh) 安装器。
  从 mem0-claude-kit 只读复制运行时文件，安装 dsh 侧插件/skills/配置。
  mem0-claude-kit 目录零改动；与 Claude CLI 安装（~/.mem0-claude）完全隔离。

.DESCRIPTION
  安装内容：
    1. 运行时：套件 mem0_hooks.py → ~/.mem0-claude-dsh/original/（只读复制）
              mem0-mcp 源码   → ~/.mem0-claude-dsh/mcp/（uv sync 预建 venv）
              tools 副本      → ~/.mem0-claude-dsh/tools/
    2. 包装层：Assistant/hooks/mem0_hooks_dsh.py → ~/.mem0-claude-dsh/hooks/
    3. 插件：  Assistant/plugin/ → <profile>/plugins/mem0-dsh-bridge/（--patch 引用其源码；
               必须位于 profile 树内，dsh 才会把 @deepseek-ai/* 导入路由给插件）
    4. Skills：Assistant/skills/*.md（替换占位符）→ ~/.dsh/skills/
    5. patch：  合并 mcp-manager servers.mem0 + mem0-dsh-bridge + hooks-claude-code
              到 ~/.dsh/profiles/<profile>/cordis.patch.yml（marker 幂等）
    6. 凭证：  MEM0_API_KEY 写入 ~/.dsh/.credentials.yaml（refs 段）
    7. 引导：  agents-block.md 追加到 ~/.agents/AGENTS.md（marker 幂等）

.PARAMETER KitDir
  mem0-claude-kit 目录（只读）。默认取环境变量 MEM0_KIT_DIR，否则用仓库上级的
  mem0-2.2.0\mem0-claude-kit（与 deepseek-harness 同级）。

.PARAMETER Profile
  dsh profile 名（patch 写入其目录）。默认 web

.PARAMETER ApiUrl / ApiKey / UserId
  mem0 连接参数。ApiKey 只写入 .credentials.yaml，不进 patch 明文。
  UserId 是长期记忆的归属标识：同一个 mem0 服务里，多台机器 / Claude CLI 与 dsh
  用同一个 id 才会互相看到记忆。取一个自己稳定的值（如 me、你的名字），不要填别人的。

.PARAMETER InstallDir
  运行时目录（默认 ~/.mem0-claude-dsh）。主要用于隔离测试。

.PARAMETER DryRun
  只打印计划，不写任何文件。

.PARAMETER ReuseClaudeConfig
  参数和环境变量都没提供时，从 ~/.claude/mem0/config.json 复用 mem0 连接参数
  （已有 Claude kit 的机器可少填一遍）。

.PARAMETER SkipUvSync
  跳过 mem0-mcp 的 uv sync。首次启动 dsh 时会自动同步，只是更慢。

.PARAMETER NonInteractive
  缺连接参数时直接报错，不进入交互询问。

.EXAMPLE
  .\install-dsh.ps1 -DryRun
  .\install-dsh.ps1 -ApiUrl https://mem0.example.com:4430 -ApiKey m0sk_xxx -UserId me
  .\install-dsh.ps1 -KitDir "$env:USERPROFILE\.mem0-claude" -ReuseClaudeConfig
#>
[CmdletBinding()]
param(
    [string]$KitDir = '',
    [string]$Profile = 'web',
    [string]$ApiUrl,
    [string]$ApiKey,
    [string]$UserId,
    # 可选：开发机状态上报（mem0_hooks 1.7.22 起）。不传则保留 config.json 里已有的值。
    [string]$ReportUrl,
    [string]$ReportToken,
    [string]$MachineId,
    [string]$InstallDir = (Join-Path $env:USERPROFILE '.mem0-claude-dsh'),
    # 复用本机 Claude kit 的连接配置（~/.claude/mem0/config.json），
    # 仅在参数和环境变量都没提供时生效。
    [switch]$ReuseClaudeConfig,
    # 跳过 mem0-mcp 的 uv sync（首次启动 dsh 时会自动同步，较慢）
    [switch]$SkipUvSync,
    # 缺参数时直接报错，不进入 Read-Host（适合脚本/远程执行）
    [switch]$NonInteractive,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$AssistDir = Split-Path -Parent $PSCommandPath   # Assistant/ 目录

# 套件目录不写死本机路径：优先 MEM0_KIT_DIR，否则按仓库布局取上级的
# mem0-2.2.0\mem0-claude-kit（公开仓库里不暴露个人目录结构）。
if (-not $KitDir) {
    $KitDir = if ($env:MEM0_KIT_DIR) {
        $env:MEM0_KIT_DIR
    } else {
        Join-Path (Split-Path -Parent (Split-Path -Parent $AssistDir)) 'mem0-2.2.0\mem0-claude-kit'
    }
}
# 套件目录支持两种布局：
#   1) 套件源码目录：<KitDir>\payload\mem0_hooks.py + payload\mem0-mcp
#   2) Claude kit 安装目录（如 ~/.mem0-claude）：mem0_hooks.py + mcp\
$KitPayload = Join-Path $KitDir 'payload'
if (-not (Test-Path (Join-Path $KitPayload 'mem0_hooks.py'))) {
    if (Test-Path (Join-Path $KitDir 'mem0_hooks.py')) { $KitPayload = $KitDir }
}
$KitMcp = Join-Path $KitPayload 'mem0-mcp'
if (-not (Test-Path $KitMcp)) {
    $installedMcp = Join-Path $KitPayload 'mcp'
    if (Test-Path $installedMcp) { $KitMcp = $installedMcp }
}
$Home2     = $env:USERPROFILE
$DshHome      = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $Home2 '.dsh' }
$AgentsHome   = if ($env:DSH_AGENTS_HOME) { $env:DSH_AGENTS_HOME } else { Join-Path $Home2 '.agents' }
$SkillsDir    = Join-Path $DshHome 'skills'
$ProfileDir   = Join-Path $DshHome "profiles\$Profile"
$PatchPath    = Join-Path $ProfileDir 'cordis.patch.yml'
# dsh 的 profile resolution 只对 profile 树内的文件路由 @deepseek-ai/* 导入；
# 把插件放在 ~/.mem0-claude-dsh 下会在启动时报 "Cannot find module @deepseek-ai/..."。
$PluginDir    = Join-Path $ProfileDir 'plugins\mem0-dsh-bridge'
$CredPath     = Join-Path $DshHome '.credentials.yaml'
$AgentsMd     = Join-Path $AgentsHome 'AGENTS.md'
$DataDir      = Join-Path $DshHome 'mem0'
$KitVersion   = if (Test-Path (Join-Path $KitDir 'VERSION')) { (Get-Content (Join-Path $KitDir 'VERSION') -Raw -Encoding UTF8).Trim() } else { '' }

$PATCH_MARKER_BEGIN = '# mem0-claude-kit:dsh begin'
$PATCH_MARKER_END   = '# mem0-claude-kit:dsh end'
$AGENTS_MARKER_BEGIN = '<!-- mem0-dsh:begin'
$AGENTS_MARKER_END   = '<!-- mem0-dsh:end -->'

function Write-Plan { param($msg) if ($DryRun) { Write-Host "[dryrun] $msg" -ForegroundColor Cyan } else { Write-Host $msg } }

# PS 5.1 的 Set-Content -Encoding utf8 会写 BOM。BOM 会让两类读取失败：
#   - dsh skill parser 要求首行恰好是 `---`（BOM 前缀导致 frontmatter 不识别，skill 被忽略）
#   - Node 的 JSON.parse（hooks.json）不接受 BOM
# 所以生成的非 .ps1 文件一律用无 BOM UTF-8；.ps1 保持 BOM 供 Windows PowerShell 读中文。
function Write-Utf8NoBom { param([string]$Path, [string]$Text)
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

# ---------- 前置检查 ----------
Write-Host '== mem0-claude-kit → dsh 安装 ==' -ForegroundColor Green
if ($KitVersion) { Write-Host "   套件版本: $KitVersion" }
if ($DryRun) { Write-Host '（DryRun 模式：不写任何文件）' -ForegroundColor Yellow }

foreach ($req in @(
    @{ p = (Join-Path $KitPayload 'mem0_hooks.py'); n = '套件 mem0_hooks.py' },
    @{ p = $KitMcp;                                n = '套件 mem0-mcp' },
    @{ p = (Join-Path $AssistDir 'hooks\mem0_hooks_dsh.py'); n = '包装层 mem0_hooks_dsh.py' },
    @{ p = (Join-Path $AssistDir 'plugin\src\index.ts');     n = 'bridge 插件 index.ts' }
)) {
    if (-not (Test-Path $req.p)) { throw "缺少 $($req.n): $($req.p)" }
}

$py = $null
# 套件脚本要求 Python 3.10+。`py -3` 可能指向很旧的解释器（本机 py -3 是 3.12，
# 但 PATH 上的 python 是 3.6；某些机器 py -3 也会落到 3.6），所以先读
# `py -0p` 的解释器清单挑 >=3.10 的，再退回 PATH 上的 python；找不到就报错，
# 不把低版本写进 patch。
$pyLauncher = (Get-Command py -ErrorAction SilentlyContinue).Source
if ($pyLauncher) {
    try { $pyList = @(& $pyLauncher -0p) } catch { $pyList = @() }
    foreach ($line in $pyList) {
        if ($line -match '^\s*-V:(\d+)\.(\d+)(?:\s+\*)?\s+(.+\.exe)\s*$') {
            $maj = [int]$Matches[1]; $min = [int]$Matches[2]
            if ($maj -gt 3 -or ($maj -eq 3 -and $min -ge 10)) { $py = $Matches[3].Trim(); break }
        }
    }
}
if (-not $py) {
    $pathPython = (Get-Command python -ErrorAction SilentlyContinue).Source
    if ($pathPython) {
        try { $v = @(& $pathPython -c "import sys; print(sys.version_info[0], sys.version_info[1])") } catch { $v = @() }
        $first = $v | Select-Object -First 1
        if ($first -match '^(\d+)\s+(\d+)') {
            $maj = [int]$Matches[1]; $min = [int]$Matches[2]
            if ($maj -gt 3 -or ($maj -eq 3 -and $min -ge 10)) { $py = $pathPython }
        }
    }
}
if (-not $py) { throw '未找到 Python 3.10+（py launcher 清单与 PATH 都没有），请安装后重试' }
Write-Host "   Python: $py"
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) { Write-Warning '未找到 uv；mem0-mcp venv 预建将跳过（首次启动会自动 sync，较慢）' }

# 已有环境变量 / Claude kit 配置时直接用，不再交互询问。
# 优先级：显式参数 > 环境变量 > （-ReuseClaudeConfig）~/.claude/mem0/config.json。
$ClaudeCfg = $null
if ($ReuseClaudeConfig) {
    $claudeCfgPath = Join-Path $Home2 '.claude\mem0\config.json'
    if (Test-Path $claudeCfgPath) {
        try { $ClaudeCfg = Get-Content $claudeCfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $ClaudeCfg = $null }
    }
    if ($ClaudeCfg) {
        Write-Host '   连接参数：缺失项复用 ~/.claude/mem0/config.json'
    } else {
        Write-Warning "未找到可解析的 $claudeCfgPath，继续按参数/环境变量处理"
    }
}
if (-not $ApiUrl)      { $ApiUrl      = if ($env:MEM0_API_URL) { $env:MEM0_API_URL } elseif ($ClaudeCfg) { $ClaudeCfg.api_url } else { $null } }
if (-not $ApiKey)      { $ApiKey      = if ($env:MEM0_API_KEY) { $env:MEM0_API_KEY } elseif ($ClaudeCfg) { $ClaudeCfg.api_key } else { $null } }
if (-not $UserId)      { $UserId      = if ($env:MEM0_DEFAULT_USER_ID) { $env:MEM0_DEFAULT_USER_ID } elseif ($ClaudeCfg) { $ClaudeCfg.user_id } else { $null } }
if (-not $ReportUrl)   { $ReportUrl   = if ($env:MEM0_REPORT_URL) { $env:MEM0_REPORT_URL } elseif ($ClaudeCfg) { $ClaudeCfg.report_url } else { $null } }
if (-not $ReportToken) { $ReportToken = if ($env:MEM0_REPORT_TOKEN) { $env:MEM0_REPORT_TOKEN } elseif ($ClaudeCfg) { $ClaudeCfg.report_token } else { $null } }
if (-not $MachineId)   { $MachineId   = if ($env:MEM0_MACHINE_ID) { $env:MEM0_MACHINE_ID } elseif ($ClaudeCfg) { $ClaudeCfg.machine_id } else { $null } }

# 只报告“有没有/从哪里来”，不打印任何值；卡住时能看出是在等输入还是别处。
$apiKeyState = if ($ApiKey) { "已提供（$($ApiKey.Length) 字符）" } else { '缺失' }
$userIdState = if ($UserId) { $UserId } else { '缺失' }
$apiUrlState = if ($ApiUrl) { '已提供' } else { '缺失' }
Write-Host "   连接参数: ApiUrl=$apiUrlState / ApiKey=$apiKeyState / UserId=$userIdState"

if ($NonInteractive -and -not $DryRun) {
    if (-not $UserId) { $UserId = 'me' }
    if (-not $ApiUrl -or -not $ApiKey) {
        throw '缺少 ApiUrl/ApiKey（-NonInteractive）：请用参数或 MEM0_* 环境变量提供'
    }
}

# 交互收集缺失参数（DryRun 时不询问）
if (-not $DryRun) {
    if (-not $ApiUrl)  { $ApiUrl  = Read-Host 'mem0 API 地址（如 https://mem0.example.com:4430）' }
    if (-not $ApiKey)  { $ApiKey  = Read-Host 'mem0 API Key（m0sk_...，输入不回显）' -AsSecureString
                          $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ApiKey)) }
    if (-not $UserId)  { $UserId  = Read-Host 'mem0 user id（默认 me；同一服务下用同一个 id 才能共享长期记忆，可填自己的名字）'
                          if (-not $UserId) { $UserId = 'me' } }
}

# 占位符守卫：ApiUrl 会以 MEM0_API_URL 环境变量覆盖 ~/.dsh/mem0/config.json，
# 残留示例地址会让召回与落盘全部静默失败（hook 契约不阻塞会话）。
if ($ApiUrl -match 'example\.(com|org)') {
    Write-Warning "ApiUrl 仍是示例占位符（$ApiUrl）；安装后召回/落盘会失败，请改用真实 mem0 地址"
}

# ---------- 1. 运行时复制（套件只读） ----------
Write-Plan "1. 复制套件 mem0_hooks.py + VERSION → $InstallDir\original"
if (-not $DryRun) {
    New-Item -ItemType Directory -Force (Join-Path $InstallDir 'original') | Out-Null
    Copy-Item (Join-Path $KitPayload 'mem0_hooks.py') (Join-Path $InstallDir 'original\mem0_hooks.py') -Force
    # doctor 的「版本」检查与「已安装的 mem0_hooks.py 来自 kit x.y.z」需要它
    if (Test-Path (Join-Path $KitDir 'VERSION')) {
        Copy-Item (Join-Path $KitDir 'VERSION') (Join-Path $InstallDir 'original\VERSION') -Force
    }
}

Write-Plan "2. 复制 mem0-mcp 源码 → $InstallDir\mcp"
if (-not $DryRun) {
    $mcpDest = Join-Path $InstallDir 'mcp'
    if (Test-Path $mcpDest) { Remove-Item -Recurse -Force $mcpDest }
    New-Item -ItemType Directory -Force $mcpDest | Out-Null
    # 已安装 Claude kit 的 mcp/ 里常带 .venv：venv 内是绝对路径，复制过去也不能用，
    # 文件又很多（卡住的主因之一）。跳过它，由下面的 uv sync 重建。
    if (Test-Path (Join-Path $KitMcp '.venv')) {
        Write-Host '   跳过套件自带 .venv（目标环境重新 uv sync）'
    }
    Write-Host '   复制 mem0-mcp 源码...'
    Get-ChildItem -LiteralPath $KitMcp -Force | Where-Object { $_.Name -ne '.venv' } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $mcpDest -Recurse -Force
    }
    if ($SkipUvSync) {
        Write-Host '   已跳过 uv sync（-SkipUvSync）：首次启动 dsh 时会自动同步'
    } elseif ($uv) {
        Write-Host '   开始 uv sync（首次可能 1~3 分钟，静默；可加 -SkipUvSync 跳过）...'
        Push-Location $mcpDest
        try {
            & $uv sync --quiet
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "uv sync 失败（exit $LASTEXITCODE）；首次启动 dsh 时会重试"
            } else {
                Write-Host '   uv sync 完成'
            }
        } finally { Pop-Location }
    }
}

Write-Plan "3. 复制 tools 副本 → $InstallDir\tools"
if (-not $DryRun) {
    New-Item -ItemType Directory -Force (Join-Path $InstallDir 'tools') | Out-Null
    Copy-Item (Join-Path $AssistDir 'tools\*') (Join-Path $InstallDir 'tools\') -Force
}

# ---------- 2. 包装层 / hooks / 插件 ----------
Write-Plan "4. 安装包装层与 hooks → $InstallDir\hooks"
if (-not $DryRun) {
    New-Item -ItemType Directory -Force (Join-Path $InstallDir 'hooks') | Out-Null
    Copy-Item (Join-Path $AssistDir 'hooks\mem0_hooks_dsh.py') (Join-Path $InstallDir 'hooks\') -Force
    # hooks.json 占位符替换
    $hooksJson = Get-Content (Join-Path $AssistDir 'hooks\hooks.json') -Raw -Encoding UTF8
    $hooksDirFwd = (Join-Path $InstallDir 'hooks') -replace '\\','/'
    $hooksJson = $hooksJson.Replace('{{HOOKS_DIR}}', $hooksDirFwd)
    Write-Utf8NoBom (Join-Path $InstallDir 'hooks\hooks.json') $hooksJson
    $affHook = Get-Content (Join-Path $AssistDir 'hooks\affine-docs-hook.ps1') -Raw -Encoding UTF8
    $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodePath) { $nodePath = 'node' }
    $affHook = $affHook.Replace('{{NODE}}', $nodePath)
    $affHook = $affHook.Replace('{{TOOL}}', ((Join-Path $InstallDir 'tools\publish-project-docs.mjs') -replace '\\','/'))
    Set-Content (Join-Path $InstallDir 'hooks\affine-docs-hook.ps1') $affHook -Encoding utf8
}

Write-Plan "5. 安装 bridge 插件 → $PluginDir"
if (-not $DryRun) {
    if (Test-Path $PluginDir) { Remove-Item -Recurse -Force $PluginDir }
    New-Item -ItemType Directory -Force (Split-Path -Parent $PluginDir) | Out-Null
    Copy-Item (Join-Path $AssistDir 'plugin') $PluginDir -Recurse -Force
    # 旧版安装位置（profile 树外，导入无法解析）：升级时清掉
    if (Test-Path (Join-Path $InstallDir 'plugin')) {
        Remove-Item -Recurse -Force (Join-Path $InstallDir 'plugin')
        Write-Host '   已移除旧版的 ~/.mem0-claude-dsh/plugin（迁移到 profile 树内）'
    }
}

Write-Plan "5b. 安装 UI 插件（右栏 mem0 面板 + 会话头状态点） → $InstallDir\ui"
if (-not $DryRun) {
    if (Test-Path (Join-Path $InstallDir 'ui')) { Remove-Item -Recurse -Force (Join-Path $InstallDir 'ui') }
    Copy-Item (Join-Path $AssistDir 'ui') (Join-Path $InstallDir 'ui') -Recurse -Force
}

# ---------- 3. Skills（占位符替换） ----------
Write-Plan "6. 安装 skills → $SkillsDir"
if (-not $DryRun) {
    New-Item -ItemType Directory -Force $SkillsDir | Out-Null
    $hooksPy = (Join-Path $InstallDir 'hooks\mem0_hooks_dsh.py') -replace '\\','/'
    $toolMjs = (Join-Path $InstallDir 'tools\publish-project-docs.mjs') -replace '\\','/'
    $arcMjs  = (Join-Path $InstallDir 'tools\archive-docs.mjs') -replace '\\','/'
    $disMjs  = (Join-Path $InstallDir 'tools\distill-history.mjs') -replace '\\','/'
    Get-ChildItem (Join-Path $AssistDir 'skills') -Filter '*.md' | ForEach-Object {
        $c = Get-Content $_.FullName -Raw -Encoding UTF8
        $c = $c.Replace('{{HOOKS}}', $hooksPy).Replace('{{TOOL}}', $toolMjs).Replace('{{ARCHIVE}}', $arcMjs).Replace('{{DISTILL}}', $disMjs)
        Write-Utf8NoBom (Join-Path $SkillsDir $_.Name) $c
    }
    Write-Host "   已安装 $((Get-ChildItem (Join-Path $AssistDir 'skills') -Filter '*.md').Count) 个 skills"
}

# ---------- 4. mem0 配置 ----------
Write-Plan "7. 写 mem0 连接配置 → $DataDir\config.json"
if (-not $DryRun) {
    New-Item -ItemType Directory -Force $DataDir | Out-Null
    $cfgPath = Join-Path $DataDir 'config.json'
    # 合并而不是覆盖：report_url/report_token/machine_id 等可选键由用户或
    # 本安装器的 -Report* 参数维护，重装不能把它们清掉。
    $cfg = [ordered]@{}
    if (Test-Path $cfgPath) {
        try {
            $old = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($p in $old.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
        } catch { Write-Warning "现有 config.json 解析失败，将重写：$($_.Exception.Message)" }
    }
    if ($ApiUrl)      { $cfg['api_url']      = $ApiUrl }
    if ($ApiKey)      { $cfg['api_key']      = $ApiKey }
    if ($UserId)      { $cfg['user_id']      = $UserId }
    if ($ReportUrl)   { $cfg['report_url']   = $ReportUrl }
    if ($ReportToken) { $cfg['report_token'] = $ReportToken }
    if ($MachineId)   { $cfg['machine_id']   = $MachineId }
    Write-Utf8NoBom $cfgPath ($cfg | ConvertTo-Json)
}

# ---------- 5. 凭证（.credentials.yaml refs 段） ----------
if ($ApiKey) {
    Write-Plan "8. 写凭证 MEM0_API_KEY → $CredPath（不进 patch 明文）"
    if (-not $DryRun) {
        $doc = @{}
        if (Test-Path $CredPath) {
            # 简单解析：保留现有行，替换/追加 refs.MEM0_API_KEY
            $lines = @(Get-Content $CredPath)
            $hasRefs = ($lines | Where-Object { $_ -match '^refs:' }).Count -gt 0
            if ($hasRefs) {
                $out = @(); $inRefs = $false; $replaced = $false
                foreach ($l in $lines) {
                    if ($l -match '^refs:') { $inRefs = $true; $out += $l; continue }
                    if ($inRefs -and $l -match '^\S') { $inRefs = $false }
                    if ($inRefs -and $l -match '^\s+MEM0_API_KEY:') {
                        $out += "  MEM0_API_KEY: $ApiKey"; $replaced = $true
                    } else { $out += $l }
                }
                if (-not $replaced) {
                    # 插到 refs: 之后
                    $out = @()
                    foreach ($l in $lines) {
                        $out += $l
                        if ($l -match '^refs:') { $out += "  MEM0_API_KEY: $ApiKey" }
                    }
                }
                Write-Utf8NoBom $CredPath ($out -join "`r`n")
            } else {
                $existingText = Get-Content $CredPath -Raw -Encoding UTF8
                if ($null -eq $existingText) { $existingText = '' }
                Write-Utf8NoBom $CredPath ($existingText.TrimEnd([char[]]"`r`n") + "`r`nrefs:`r`n  MEM0_API_KEY: $ApiKey`r`n")
            }
        } else {
            New-Item -ItemType Directory -Force $DshHome | Out-Null
            Write-Utf8NoBom $CredPath "version: 1`r`nrefs:`r`n  MEM0_API_KEY: $ApiKey`r`n"
        }
    }
} else {
    Write-Plan "8. 跳过凭证（未提供 ApiKey；patch 将用 `${credential:MEM0_API_KEY} 引用）"
}

# ---------- 6. patch 合并 ----------
Write-Plan "9. 合并 patch → $PatchPath"
$uvForward = if ($uv) { ($uv -replace '\\','/') } else { 'uv' }
$installFwd = $InstallDir -replace '\\','/'
$pluginEntry = (Join-Path $PluginDir 'src\index.ts') -replace '\\','/'
$hooksJsonPath = (Join-Path $InstallDir 'hooks\hooks.json') -replace '\\','/'
$dataFwd = $DataDir -replace '\\','/'
$pyFwd = $py -replace '\\','/'

$patchBlock = @"
$PATCH_MARKER_BEGIN
# ---- mcp-manager：mem0 server（注意：patch 会替换整个 servers map，
#      如你配置过其他 MCP server，请在此块中一并重述） ----
- id: mcp-manager
  config:
    servers:
      mem0:
        transport: stdio
        command: '$uvForward'
        args: ['run', '--no-sync', '--directory', '$installFwd/mcp', 'mem0-mcp']
        env:
          MEM0_API_URL: '$ApiUrl'
          MEM0_API_KEY: '`${credential:MEM0_API_KEY}'
          MEM0_DEFAULT_USER_ID: '$UserId'

- insert:
    # ---- mem0 记忆桥（原生插件：事件→子命令翻译） ----
    - id: mem0-dsh-bridge
      name: '$pluginEntry'
      config:
        python: '$pyFwd'
        hooksScript: '$installFwd/hooks/mem0_hooks_dsh.py'
        dataDir: '$dataFwd'
        apiUrl: '$ApiUrl'
        userId: '$UserId'
    # ---- Claude Code hooks 桥（只承载 AFFiNE 文档发布 hook） ----
    - id: hooks-claude-code
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: '$hooksJsonPath'
        projectDir: '$installFwd'
    # ---- mem0 UI 插件（client 插件：右栏 mem0 面板 + 会话头状态点） ----
    - id: mem0-dsh-ui
      name: '$installFwd/ui/index.js'
$PATCH_MARKER_END
"@

if (-not $DryRun) {
    New-Item -ItemType Directory -Force $ProfileDir | Out-Null
    if (Test-Path $PatchPath) {
        $existing = Get-Content $PatchPath -Raw -Encoding UTF8
        if ($null -eq $existing) { $existing = '' }
        if ($existing -match [regex]::Escape($PATCH_MARKER_BEGIN)) {
            # 幂等替换旧块
            $pattern = "(?s)" + [regex]::Escape($PATCH_MARKER_BEGIN) + ".*?" + [regex]::Escape($PATCH_MARKER_END)
            $merged = [regex]::Replace($existing, $pattern, $patchBlock.Replace('$', '$$'))
            Write-Utf8NoBom $PatchPath $merged
        } else {
            Write-Utf8NoBom $PatchPath ($existing.TrimEnd([char[]]"`r`n") + "`r`n" + $patchBlock + "`r`n")
        }
    } else {
        Write-Utf8NoBom $PatchPath "$patchBlock`r`n"
    }
}

# ---------- 7. AGENTS.md 引导 ----------
Write-Plan "10. 追加引导块 → $AgentsMd"
if (-not $DryRun) {
    New-Item -ItemType Directory -Force $AgentsHome | Out-Null
    $block = Get-Content (Join-Path $AssistDir 'templates\agents-block.md') -Raw -Encoding UTF8
    $existingMd = if (Test-Path $AgentsMd) { Get-Content $AgentsMd -Raw -Encoding UTF8 } else { '' }
    if ($null -eq $existingMd) { $existingMd = '' }
    if ($existingMd -match [regex]::Escape($AGENTS_MARKER_BEGIN)) {
        $pattern = "(?s)" + [regex]::Escape($AGENTS_MARKER_BEGIN) + ".*?" + [regex]::Escape($AGENTS_MARKER_END)
        $merged = [regex]::Replace($existingMd, $pattern, $block.Replace('$', '$$'))
        Write-Utf8NoBom $AgentsMd $merged
    } else {
        Write-Utf8NoBom $AgentsMd ($existingMd.TrimEnd([char[]]"`r`n") + "`r`n" + $block + "`r`n")
    }
}

Write-Host ''
Write-Host '== 安装完成 ==' -ForegroundColor Green
Write-Host "启动验证：  pnpm dsh web   （Settings → MCP 应显示 mem0 connected）"
Write-Host "会话验证：  在会话里运行 /mem0-status、/mem0-search 测试"
Write-Host "patch 文件： $PatchPath"
Write-Host "数据目录：  $DataDir（与 Claude CLI 的 ~/.claude/mem0 互相独立）"
