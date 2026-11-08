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
  mem0-claude-kit 目录（只读）。默认 D:\Working\AIAssistantDev\mem0-2.2.0\mem0-claude-kit

.PARAMETER Profile
  dsh profile 名（patch 写入其目录）。默认 web

.PARAMETER ApiUrl / ApiKey / UserId
  mem0 连接参数。ApiKey 只写入 .credentials.yaml，不进 patch 明文。

.PARAMETER DryRun
  只打印计划，不写任何文件。

.EXAMPLE
  .\install-dsh.ps1 -DryRun
  .\install-dsh.ps1 -ApiUrl https://mem0.example.com:4430 -ApiKey m0sk_xxx -UserId jesse
#>
[CmdletBinding()]
param(
    [string]$KitDir = 'D:\Working\AIAssistantDev\mem0-2.2.0\mem0-claude-kit',
    [string]$Profile = 'web',
    [string]$ApiUrl,
    [string]$ApiKey,
    [string]$UserId,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$AssistDir = Split-Path -Parent $PSCommandPath   # Assistant/ 目录
$Home2     = $env:USERPROFILE
$InstallDir   = Join-Path $Home2 '.mem0-claude-dsh'
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

$PATCH_MARKER_BEGIN = '# mem0-claude-kit:dsh begin'
$PATCH_MARKER_END   = '# mem0-claude-kit:dsh end'
$AGENTS_MARKER_BEGIN = '<!-- mem0-dsh:begin'
$AGENTS_MARKER_END   = '<!-- mem0-dsh:end -->'

function Write-Plan { param($msg) if ($DryRun) { Write-Host "[dryrun] $msg" -ForegroundColor Cyan } else { Write-Host $msg } }

# ---------- 前置检查 ----------
Write-Host '== mem0-claude-kit → dsh 安装 ==' -ForegroundColor Green
if ($DryRun) { Write-Host '（DryRun 模式：不写任何文件）' -ForegroundColor Yellow }

foreach ($req in @(
    @{ p = (Join-Path $KitDir 'payload\mem0_hooks.py'); n = '套件 mem0_hooks.py' },
    @{ p = (Join-Path $KitDir 'payload\mem0-mcp');      n = '套件 mem0-mcp' },
    @{ p = (Join-Path $AssistDir 'hooks\mem0_hooks_dsh.py'); n = '包装层 mem0_hooks_dsh.py' },
    @{ p = (Join-Path $AssistDir 'plugin\src\index.ts');     n = 'bridge 插件 index.ts' }
)) {
    if (-not (Test-Path $req.p)) { throw "缺少 $($req.n): $($req.p)" }
}

$py = $null
# 优先 py launcher 的最新 Python 3（PATH 上的 python 可能是旧版本，如 3.6），
# 其次 PATH 上的 python；都拿不到再报错。
$pyLauncher = (Get-Command py -ErrorAction SilentlyContinue).Source
if ($pyLauncher) {
    $candidate = & $pyLauncher -3 -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $candidate) { $py = ($candidate | Select-Object -First 1).Trim() }
}
if (-not $py) { $py = (Get-Command python -ErrorAction SilentlyContinue).Source }
if (-not $py) { throw '未找到 python，请先安装 Python 3.10+' }
if ((& $py --version 2>&1) -match 'Python 3\.([0-9]+)' -and [int]$Matches[1] -lt 10) {
    Write-Warning "所选 Python 版本偏低（$(& $py --version 2>&1)），套件脚本需要 3.10+ 语法；请用 -Profile 环境变量或 PATH 指向新版 Python"
}
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) { Write-Warning '未找到 uv；mem0-mcp venv 预建将跳过（首次启动会自动 sync，较慢）' }

# 交互收集缺失参数（DryRun 时不询问）
if (-not $DryRun) {
    if (-not $ApiUrl)  { $ApiUrl  = Read-Host 'mem0 API 地址（如 https://mem0.example.com:4430）' }
    if (-not $ApiKey)  { $ApiKey  = Read-Host 'mem0 API Key（m0sk_...，输入不回显）' -AsSecureString
                          $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ApiKey)) }
    if (-not $UserId)  { $UserId  = Read-Host 'mem0 user id（默认 jesse）'
                          if (-not $UserId) { $UserId = 'jesse' } }
}

# 占位符守卫：ApiUrl 会以 MEM0_API_URL 环境变量覆盖 ~/.dsh/mem0/config.json，
# 残留示例地址会让召回与落盘全部静默失败（hook 契约不阻塞会话）。
if ($ApiUrl -match 'example\.(com|org)') {
    Write-Warning "ApiUrl 仍是示例占位符（$ApiUrl）；安装后召回/落盘会失败，请改用真实 mem0 地址"
}

# ---------- 1. 运行时复制（套件只读） ----------
Write-Plan "1. 复制套件 mem0_hooks.py → $InstallDir\original"
if (-not $DryRun) {
    New-Item -ItemType Directory -Force (Join-Path $InstallDir 'original') | Out-Null
    Copy-Item (Join-Path $KitDir 'payload\mem0_hooks.py') (Join-Path $InstallDir 'original\mem0_hooks.py') -Force
}

Write-Plan "2. 复制 mem0-mcp 源码 → $InstallDir\mcp"
if (-not $DryRun) {
    if (Test-Path (Join-Path $InstallDir 'mcp')) { Remove-Item -Recurse -Force (Join-Path $InstallDir 'mcp') }
    Copy-Item (Join-Path $KitDir 'payload\mem0-mcp') (Join-Path $InstallDir 'mcp') -Recurse -Force
    if ($uv) {
        Push-Location (Join-Path $InstallDir 'mcp')
        try { & $uv sync --quiet; Write-Host '   uv sync 完成' } finally { Pop-Location }
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
    Set-Content (Join-Path $InstallDir 'hooks\hooks.json') $hooksJson -Encoding utf8
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
        Set-Content (Join-Path $SkillsDir $_.Name) $c -Encoding utf8 -NoNewline
    }
    Write-Host "   已安装 $((Get-ChildItem (Join-Path $AssistDir 'skills') -Filter '*.md').Count) 个 skills"
}

# ---------- 4. mem0 配置 ----------
Write-Plan "7. 写 mem0 连接配置 → $DataDir\config.json"
if (-not $DryRun) {
    New-Item -ItemType Directory -Force $DataDir | Out-Null
    @{ api_url = $ApiUrl; api_key = $ApiKey; user_id = $UserId } | ConvertTo-Json |
        Set-Content (Join-Path $DataDir 'config.json') -Encoding utf8
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
                Set-Content $CredPath ($out -join "`r`n") -Encoding utf8
            } else {
                Add-Content $CredPath "`r`nrefs:`r`n  MEM0_API_KEY: $ApiKey" -Encoding utf8
            }
        } else {
            New-Item -ItemType Directory -Force $DshHome | Out-Null
            Set-Content $CredPath "version: 1`r`nrefs:`r`n  MEM0_API_KEY: $ApiKey" -Encoding utf8
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
- id: mcp
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
        if ($existing -match [regex]::Escape($PATCH_MARKER_BEGIN)) {
            # 幂等替换旧块
            $pattern = "(?s)" + [regex]::Escape($PATCH_MARKER_BEGIN) + ".*?" + [regex]::Escape($PATCH_MARKER_END)
            $merged = [regex]::Replace($existing, $pattern, $patchBlock.Replace('$', '$$'))
            Set-Content $PatchPath $merged -Encoding utf8 -NoNewline
        } else {
            Add-Content $PatchPath "`r`n$patchBlock" -Encoding utf8
        }
    } else {
        Set-Content $PatchPath "$patchBlock`r`n" -Encoding utf8
    }
}

# ---------- 7. AGENTS.md 引导 ----------
Write-Plan "10. 追加引导块 → $AgentsMd"
if (-not $DryRun) {
    New-Item -ItemType Directory -Force $AgentsHome | Out-Null
    $block = Get-Content (Join-Path $AssistDir 'templates\agents-block.md') -Raw -Encoding UTF8
    if ((Test-Path $AgentsMd) -and ((Get-Content $AgentsMd -Raw -Encoding UTF8) -match [regex]::Escape($AGENTS_MARKER_BEGIN))) {
        $existing = Get-Content $AgentsMd -Raw -Encoding UTF8
        $pattern = "(?s)" + [regex]::Escape($AGENTS_MARKER_BEGIN) + ".*?" + [regex]::Escape($AGENTS_MARKER_END)
        $merged = [regex]::Replace($existing, $pattern, $block.Replace('$', '$$'))
        Set-Content $AgentsMd $merged -Encoding utf8 -NoNewline
    } else {
        Add-Content $AgentsMd "`r`n$block" -Encoding utf8
    }
}

Write-Host ''
Write-Host '== 安装完成 ==' -ForegroundColor Green
Write-Host "启动验证：  pnpm dsh web   （Settings → MCP 应显示 mem0 connected）"
Write-Host "会话验证：  在会话里运行 /mem0-status、/mem0-search 测试"
Write-Host "patch 文件： $PatchPath"
Write-Host "数据目录：  $DataDir（与 Claude CLI 的 ~/.claude/mem0 互相独立）"
