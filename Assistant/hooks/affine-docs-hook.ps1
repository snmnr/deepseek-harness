# AFFiNE 文档发布 hook（dsh 侧副本，行为对齐 mem0-claude-kit 的 project-docs-hook.ps1）
# 触发条件：PostToolUse (write/edit)，且项目根有 .affine-docs.config.json。
# dsh 桥 payload：stdin JSON { tool_name, tool_input: { filePath/content... }, cwd }。
# 结果走 stderr（桥会把 stderr 摘要记入 hook/result 事件）。
#
# 路径占位 {{NODE}} {{TOOL}} 由 install-dsh.ps1 替换。
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Main {
    try {
        $raw = [Console]::In.ReadToEnd()
        if (-not $raw.Trim()) { exit 0 }
        $payload = $raw | ConvertFrom-Json
    } catch {
        [Console]::Error.WriteLine("affine-docs-hook: 无法解析 stdin JSON")
        exit 0
    }

    $toolInput = $payload.tool_input
    if ($null -eq $toolInput) { exit 0 }
    $filePath = $toolInput.file_path
    if (-not $filePath) { $filePath = $toolInput.filePath }
    if (-not $filePath) { exit 0 }
    if ($filePath -notmatch '\.md$') { exit 0 }

    $cwd = $payload.cwd
    if (-not $cwd) { $cwd = (Get-Location).Path }
    if (-not (Test-Path (Join-Path $cwd '.affine-docs.config.json'))) { exit 0 }

    $node = '{{NODE}}'
    $tool = '{{TOOL}}'
    if (-not (Test-Path $tool)) {
        [Console]::Error.WriteLine("affine-docs-hook: 发布器不存在: $tool")
        exit 0
    }

    # 后台发布，不阻塞工具结果；输出进 stderr 由桥记录
    $log = Join-Path $env:USERPROFILE '.mem0-claude-dsh\affine-hook.log'
    try {
        $out = & $node $tool $cwd --files $filePath 2>&1
        Add-Content -Path $log -Value ("[{0}] {1}: {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $filePath, ($out -join ' ')) -Encoding UTF8
        [Console]::Error.WriteLine("affine-docs-hook: 已发布 $filePath")
    } catch {
        [Console]::Error.WriteLine("affine-docs-hook: 发布失败 $filePath : $($_.Exception.Message)")
    }
    exit 0
}

Main
