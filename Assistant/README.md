# mem0-claude-kit → deepseek-harness（dsh）移植版

本目录是 mem0-claude-kit（Claude Code 长期记忆/AFFiNE 文档闭环套件）在 dsh 上的**全新移植实现**。
套件原目录（`D:\Working\AIAssistantDev\mem0-2.2.0\mem0-claude-kit`）**零改动**，继续服务 Claude CLI；
两侧数据完全隔离（`~/.mem0-claude` vs `~/.mem0-claude-dsh`，`~/.claude/mem0` vs `~/.dsh/mem0`）。

## 为什么需要原生插件

dsh 自带的 Claude Code hooks 桥（`packages/experimental/hooks-claude-code`）只支持 7/30 个事件，
且 `transcript_path` 恒为空串（会话日志 Zstd 压缩）。套件里依赖 transcript 的核心能力
（助手结论捕获、checkpoint、蒸馏素材导出）走桥会静默失效。

因此分层如下：

| 层 | 承载 | 位置 |
|---|---|---|
| A. MCP 配置翻译 | mem0-mcp 注册进 mcp-manager（`${credential:MEM0_API_KEY}`） | patch 块 |
| B. **原生插件 mem0-dsh-bridge** | 助手结论捕获、失败捕获、召回注入、flush 时机、checkpoint、蒸馏导出 | `plugin/src/*.ts` |
| C. hooks 桥 | 仅 AFFiNE 文档发布 hook（只读 tool_input.file_path，不需要 transcript） | `hooks/hooks.json` |
| D. Skills | 13 个命令（mem0-remember/search/…、publish-project-docs、handoff…） | `skills/*.md` |
| E. 指令引导 | 记忆使用规则追加到 `~/.agents/AGENTS.md` | `templates/agents-block.md` |

## 目录结构

```
Assistant/
├─ install-dsh.ps1 / uninstall-dsh.ps1   # 安装/卸载（幂等、-DryRun、-PurgeData）
├─ README.md                             # 本文件
├─ plugin/
│  ├─ src/index.ts                       # 桥入口：dsh 事件 → Python 子命令翻译 + context 注入
│  ├─ src/capture.ts                     # spawn python 执行 mem0_hooks 子命令（永不抛错）
│  ├─ src/checkpoint.ts                  # context_guard 等价物（进程内环形缓冲 + 真实 usage token）
│  ├─ src/export.ts                      # agent/disposed 时导出 CC 兼容 JSONL + distill pending
│  └─ cordis.yml                         # 源码启动 --patch 挂载样例
├─ hooks/
│  ├─ mem0_hooks_dsh.py                  # 包装层：按路径加载套件原 mem0_hooks.py（零改动），
│  │                                     #   覆写 DATA_DIR/CONFIG_PATH，新增 assistant / ui-status 子命令
│  ├─ hooks.json                         # AFFiNE 桥配置（PostToolUse matcher 为 dsh 小写工具名）
│  └─ affine-docs-hook.ps1               # .md 写入 → 后台发布（项目根需有 .affine-docs.config.json）
├─ skills/                               # 13 个 skill 模板（{{HOOKS}}/{{TOOL}}/{{ARCHIVE}}/{{DISTILL}} 占位符）
├─ tools/                                # distill-history.mjs（--projects/DSH_EXPORT_DIR 改动版）等副本
├─ templates/agents-block.md             # AGENTS.md 引导块
└─ ui/                                   # client 插件（P9）：右栏 mem0 面板 + 会话头状态点
```

## 安装

```powershell
# 审计（不写任何文件）
D:\Working\AIAssistantDev\deepseek-harness\Assistant\install-dsh.ps1 -DryRun

# 实装（缺参会交互询问 ApiUrl / ApiKey / UserId）
D:\Working\AIAssistantDev\deepseek-harness\Assistant\install-dsh.ps1 `
  -ApiUrl https://mem0.<你的域名>:4430 `
  -ApiKey m0sk_xxx `
  -UserId jesse
```

> **ApiUrl 必须填真实地址。** 它会以 `MEM0_API_URL` 环境变量注入 hook 子进程，
> 优先级高于 `~/.dsh/mem0/config.json`；残留 `example.com` 占位符时，召回与落盘
> 都会静默失败（hook 契约不阻塞会话，只在 stderr 留一行）。安装器会对此告警。

安装动作（全部幂等）：

1. 套件运行时**只读复制**到 `~/.mem0-claude-dsh/`（original/ mcp/ tools/；mcp/ 预建 uv venv）
2. 包装层 + hooks.json（占位符替换）→ `~/.mem0-claude-dsh/hooks/`
3. bridge 插件源码 → `~/.mem0-claude-dsh/plugin/`
4. 13 个 skills（占位符替换）→ `~/.dsh/skills/`
5. mem0 连接配置 → `~/.dsh/mem0/config.json`
6. API key → `~/.dsh/.credentials.yaml` 的 `refs.MEM0_API_KEY`（不进 patch 明文）
7. patch 块（marker `# mem0-claude-kit:dsh begin/end` 幂等合并）→
   `~/.dsh/profiles/web/cordis.patch.yml`：mcp-manager `servers.mem0` + `mem0-dsh-bridge` 插件 + hooks-claude-code 桥
8. AGENTS.md 引导块（marker 幂等）→ `~/.agents/AGENTS.md`

> **patch 会替换 mcp-manager 的整个 `servers` map**。如已配置其他 MCP server，
> 请把它们的定义重述进 patch 块内（安装器不会自动迁移）。
>
> marker 块（`# mem0-claude-kit:dsh begin` … `end`）之间的内容归安装器所有，
> 重装时整体替换。你自己的 profile 配置（模型、provider、主题等）必须写在
> marker 块**外**，否则会被静默覆盖。

## 卸载

```powershell
D:\Working\AIAssistantDev\deepseek-harness\Assistant\uninstall-dsh.ps1            # 保留 ~/.dsh/mem0 数据
D:\Working\AIAssistantDev\deepseek-harness\Assistant\uninstall-dsh.ps1 -PurgeData # 连数据一起删
```

## 事件映射（bridge 插件）

| dsh 事件 | mem0_hooks 子命令 | 对应 Claude Code hook |
|---|---|---|
| `agent/created`（source 含 compaction → flush） | session-start / flush | SessionStart / PreCompact |
| `agent/pre-step`（用户文本） | user-prompt + 召回注入 | UserPromptSubmit |
| `tools/result`（isError 分支） | post-tool / post-tool-failure | PostToolUse + **PostToolUseFailure**（桥不支持，原生补齐） |
| `session/event: assistant/message` | assistant（事件尾去重） | Stop 的 transcript 抓取替代 |
| `session/event: compaction/start` | flush | PreCompact |
| `agent/turn-stopping` | checkpoint 写出 + 满阈值 flush-detached | Stop flush 触发 |
| `agent/disposed` | session-end + 蒸馏 JSONL 导出 | SessionEnd |
| `subagent/start / end` | subagent-start / subagent-stop | SubagentStart / Stop |

沉淀契约（buffer_<sid>.json、6000 chars 分片、脱敏、陈旧缓冲抢救、TTL）单点留在
套件原 `mem0_hooks.py`，本层不改不复制逻辑，仅覆写模块常量。

## 验证

```powershell
# 包装层链路（不需要启动 dsh）
python ~/.mem0-claude-dsh/hooks/mem0_hooks_dsh.py ui-status
echo '{"session_id":"t1","cwd":".","text":"测试"}' | python ~/.mem0-claude-dsh/hooks/mem0_hooks_dsh.py assistant
python ~/.mem0-claude-dsh/hooks/mem0_hooks_dsh.py status

# 全链路
pnpm dsh web     # Settings → MCP 应显示 mem0 connected
# 会话内：/mem0-status → /mem0-search 测试 → 写几轮对话 → /distill-history
```

蒸馏导出只在**进程优雅退出**时写出（终端 Ctrl+C / 正常终止）：`agent/disposed` 是
emit 事件，`taskkill /F` 或关网页都不会触发。产物为
`~/.mem0-claude-dsh/exports/<项目slug>/<会话ID>.jsonl`，同时登记到
`~/.affine-docs/distill/pending.json`（`source: "dsh"`）。

checkpoint 产物写在**会话工作区**的 `notes/_state/last-checkpoint.{json,md}`
（不可写回退 `~/.dsh/state/checkpoints/<slug>/`）。dsh 未选目录时工作区是
`<文档>/deepseek-harness/default-workspace`，所以产物不在仓库根目录下——
要核对时先看会话的 `cwd`。同一目录还有 UI 面板读取的 `notes/_state/mem0-status.json`。
阈值环境变量 `CONTEXT_GUARD_WARN/URGENT/CRITICAL`（默认 0.6/0.75/0.9，相对上下文窗口）。

## 状态面板 / 通知（P9 UI 插件）

dsh 无系统通知 API；本移植用 **client 插件**（`Assistant/ui/`）做可见性：

- **右栏 mem0 面板**：注册 `mem0` tab 类型（extension 带），body 通过
  `remote.workspaceFiles.read` 读取会话工作区 `notes/_state/mem0-status.json`，
  显示服务地址、当前会话缓冲条数、暂停态、上下文警卫级别、累计 tokens、最近落盘时间。
- **会话头状态点**：`conversation.session.header.actions` 里渲染 `● mem0` /
  `⏸ mem0`（暂停时变琥珀色），点击打开右栏面板。
- **数据源**：host 侧 bridge 插件在 `agent/created` 与每个 `agent/turn-stopping`
  边界调用包装层 `ui-status` 子命令，把结果合并 guard 级别/tokens 写入
  `notes/_state/mem0-status.json`（不可写回退 `~/.dsh/state/mem0/`，此时面板
  显示「状态文件不可读」）。会话结束标记 `ended: true`。
- **刷新**：文件 change 通道为主，面板另带 15s 轮询兜底。
- **任务完成提醒**：由 dsh 自带 completion-reminder 承担；插件不做系统弹窗。

UI 包为手写 closure-factory bundle（无需构建），patch 里以
`name: '<installDir>/ui/index.js'` 挂载。

## 与 Claude CLI 安装的关系

| | Claude CLI（套件原安装） | dsh（本移植） |
|---|---|---|
| 运行时目录 | `~/.mem0-claude` | `~/.mem0-claude-dsh` |
| 数据目录 | `~/.claude/mem0` | `~/.dsh/mem0` |
| hook 脚本 | 套件 install.ps1 装的 mem0_hooks.py | 同一脚本的副本 + `mem0_hooks_dsh.py` 包装层 |
| 记忆库 | 同一个 mem0 服务（同一 user_id 即共享长期记忆） | 同左 |

两侧 mem0 指向同一服务与 user_id 时**长期记忆互通**；会话缓冲互不干扰。

## 已知限制

- 插件以 `.ts` 源码挂载，要求从 monorepo 源码启动（`pnpm dsh web`）；打包安装需先 tsc 预编译。
- skill 的 `$ARGUMENTS` 透传行为依赖 dsh skill-filesystem 实现，若不透传需调整措辞。
- 状态栏/通知：dsh 无系统通知 API；P9 的 client 插件提供右栏面板与会话头状态指示，
  任务完成提醒由 dsh 自带 completion-reminder 承担。
- **跨侧记忆互通取决于 `metadata.project` 标签。** 套件按「工作目录名」打标并在召回时
  只保留同项目记忆。dsh 未选目录时工作区是 `.../deepseek-harness/default-workspace`，
  标签会是 `default-workspace`，与 Claude CLI 侧（按仓库目录名打标）对不上，互相召回为空。
  要在同一项目共享，应在 dsh 里把工作区设为项目目录本身。
- bridge 的 `apiUrl` 以环境变量覆盖 `config.json`；改服务地址时两处都要改（或用安装器重装）。
