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
| D. Skills | 14 个命令（mem0-remember/search/doctor/…、publish-project-docs、handoff…） | `skills/*.md` |
| E. 指令引导 | 记忆使用规则追加到 `~/.agents/AGENTS.md` | `templates/agents-block.md` |

## 目录结构

```
Assistant/
├─ install-dsh.ps1 / uninstall-dsh.ps1   # 安装/卸载（幂等、-DryRun、-PurgeData）
├─ README.md                             # 本文件
├─ plugin/
│  ├─ src/index.ts                       # 桥入口：dsh 事件 → Python 子命令翻译 + context 注入
│  ├─ src/capture.ts                     # spawn python 执行 mem0_hooks 子命令（永不抛错）
│  ├─ src/checkpoint.ts                  # context_guard 等价物（环形缓冲 + 真实 usage token +
│  │                                     #   自动 handoff + 上下文 warn + 启动续接，状态格式与套件 v1.8 互通）
│  ├─ src/export.ts                      # agent/disposed 时导出 CC 兼容 JSONL + distill pending
│  └─ cordis.yml                         # 源码启动 --patch 挂载样例
├─ hooks/
│  ├─ mem0_hooks_dsh.py                  # 包装层：按路径加载套件原 mem0_hooks.py（零改动），
│  │                                     #   覆写 DATA_DIR/CONFIG_PATH，新增 assistant / ui-status 子命令
│  ├─ hooks.json                         # AFFiNE 桥配置（PostToolUse matcher 为 dsh 小写工具名）
│  └─ affine-docs-hook.ps1               # .md 写入 → 后台发布（项目根需有 .affine-docs.config.json；
│                                        #   dsh payload 不带 cwd，从文件路径向上找项目根）
├─ skills/                               # 14 个 skill 模板（{{HOOKS}}/{{TOOL}}/{{ARCHIVE}}/{{DISTILL}} 占位符）
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

1. 套件运行时**只读复制**到 `~/.mem0-claude-dsh/`（original/ 含 `mem0_hooks.py` + `VERSION`；
   mcp/ 预建 uv venv；tools/）
2. 包装层 + hooks.json（占位符替换）→ `~/.mem0-claude-dsh/hooks/`
3. bridge 插件源码 → `~/.dsh/profiles/<profile>/plugins/mem0-dsh-bridge/`
   （**必须在 profile 树内**：dsh 的 profile resolution 只对 profile 目录下的文件
   路由 `@deepseek-ai/*` 导入；装在 `~/.mem0-claude-dsh/` 下会启动即报
   `Cannot find module '@deepseek-ai/schemastery'`，整个桥静默不激活）
4. 14 个 skills（占位符替换）→ `~/.dsh/skills/`
5. mem0 连接配置 → `~/.dsh/mem0/config.json`（**合并**写入；可选
   `-ReportUrl/-ReportToken/-MachineId` 维护状态上报，不传则保留已有值）
6. API key → `~/.dsh/.credentials.yaml` 的 `refs.MEM0_API_KEY`（不进 patch 明文）
7. patch 块（marker `# mem0-claude-kit:dsh begin/end` 幂等合并）→
   `~/.dsh/profiles/web/cordis.patch.yml`：mcp-manager `servers.mem0` + `mem0-dsh-bridge` 插件 + hooks-claude-code 桥
8. AGENTS.md 引导块（marker 幂等）→ `~/.agents/AGENTS.md`

> **patch 会替换 mcp-manager 的整个 `servers` map**。如已配置其他 MCP server，
> 请把它们的定义重述进 patch 块内（安装器不会自动迁移）。
>
> 行 id 必须写 `mcp-manager`（web/desktop bundle 里的实际行 id）。上游
> `dsh-mcp-manager` README 的示例用 `- id: mcp`，照抄会匹配不到任何行、
> 服务器静默不挂载——Settings → MCP 里也没有条目。
>
> marker 块（`# mem0-claude-kit:dsh begin` … `end`）之间的内容归安装器所有，
> 重装时整体替换。你自己的 profile 配置（模型、provider、主题等）必须写在
> marker 块**外**，否则会被静默覆盖。

## 一键启动

`start-dsh.ps1` 从仓库源码启动 Web UI（mem0-dsh-bridge 是 `.ts` 插件，必须源码启动，
不能用 `npx` 的打包版）：

```powershell
.\Assistant\start-dsh.ps1                 # 默认 http://127.0.0.1:3080，自动开浏览器
.\Assistant\start-dsh.ps1 -Check          # 只检查环境，不启动
.\Assistant\start-dsh.ps1 -Port 3081 -NoOpen
.\Assistant\start-dsh.ps1 -Install        # 强制重跑 pnpm install（修复依赖）
.\Assistant\start-dsh.ps1 -NoBootstrap    # 缺 pnpm / node_modules 时只报错，不自动补齐
```

也可以直接双击 `Assistant\start-dsh.cmd`（等价于无参数运行 `start-dsh.ps1`）。

- 自动补齐：缺 pnpm 时用 `npm install -g pnpm@11.28.5` 安装；缺 `node_modules` 时自动
  `pnpm install`。Node.js 本身需要 >= 24.9，缺失时给出 winget 安装命令；
- 不依赖 Explorer 继承的旧 PATH：会从 `C:\Program Files\nodejs`、`%APPDATA%\npm`
  等常见位置解析 node/pnpm（刚装完 Node 没重启资源管理器也能启动）；
- 端口被占用会直接报出占用 PID，换 `-Port` 即可；
- 日志写到 `~/.mem0-claude-dsh/logs/dsh-web-<时间>.log`；
- mem0 桥未安装时只告警（网页仍可启动）：先跑 `install-dsh.ps1`。

## 卸载

```powershell
D:\Working\AIAssistantDev\deepseek-harness\Assistant\uninstall-dsh.ps1            # 保留 ~/.dsh/mem0 数据
D:\Working\AIAssistantDev\deepseek-harness\Assistant\uninstall-dsh.ps1 -PurgeData # 连数据一起删
```

## 事件映射（bridge 插件）

| dsh 事件 | mem0_hooks 子命令 | 对应 Claude Code hook |
|---|---|---|
| `agent/created`（startup/clear → 续接注入；compact → flush） | session-start / resume / flush | SessionStart / PreCompact |
| `agent/pre-step`（用户文本） | user-prompt + 召回注入 | UserPromptSubmit |
| `tools/result`（isError 分支） | post-tool / post-tool-failure + 上下文 warn 检查 | PostToolUse + **PostToolUseFailure**（桥不支持，原生补齐） |
| `session/event: assistant/message` | assistant（事件尾去重） | Stop 的 transcript 抓取替代 |
| `session/event: compaction/start` | flush + **强制 checkpoint**（+ 达阈值刷新 handoff） | PreCompact |
| `agent/turn-stopping` | checkpoint + 自动 handoff（≥阈值）+ 上下文 warn（stop 内按阈值 flush-detached） | Stop |
| `agent/disposed` | session-end + 蒸馏 JSONL 导出 | SessionEnd |
| `subagent/start / end` | subagent-start / subagent-stop | SubagentStart / Stop |

沉淀契约（buffer_<sid>.json、2000 chars 分片、脱敏、陈旧缓冲抢救、TTL、flush 锁、
dead-letter、doctor、状态上报）单点留在套件原 `mem0_hooks.py`，本层不改不复制逻辑，
仅覆写模块常量（`DATA_DIR`/上报配置）与后台入口（`_spawn_background`）。
套件 `VERSION` 一并复制到 `~/.mem0-claude-dsh/original/`，`doctor` 因此能显示来源版本。

## 验证

```powershell
# 包装层链路（不需要启动 dsh）
python ~/.mem0-claude-dsh/hooks/mem0_hooks_dsh.py ui-status
echo '{"session_id":"t1","cwd":".","text":"测试"}' | python ~/.mem0-claude-dsh/hooks/mem0_hooks_dsh.py assistant
python ~/.mem0-claude-dsh/hooks/mem0_hooks_dsh.py status
python ~/.mem0-claude-dsh/hooks/mem0_hooks_dsh.py doctor   # 配置/积压/dead-letter/版本

# 全链路
pnpm dsh web     # Settings → MCP 应显示 mem0 connected
# 会话内：/mem0-status → /mem0-search 测试 → 写几轮对话 → /distill-history
```

蒸馏导出只在**进程优雅退出**时写出（终端 Ctrl+C / 正常终止）：`agent/disposed` 是
emit 事件，`taskkill /F` 或关网页都不会触发。产物为
`~/.mem0-claude-dsh/exports/<项目slug>/<会话ID>.jsonl`，同时登记到
`~/.affine-docs/distill/pending.json`（`source: "dsh"`）。

checkpoint 产物写在**项目根**（沿会话工作区向上找 `.git` 或 `CLAUDE.md`，与
`context_guard.py` 一致，工作区是子目录时也能和 CC 侧对齐）的
`notes/_state/last-checkpoint.{json,md}`，并另留一份
`notes/YYYY/MM/YYYY-MM-DD-HHMM-checkpoint.md`（每个 dated 目录保留最近 30 份）。
项目目录不可写时回退 `~/.dsh/state/checkpoints/<slug>/`。dsh 未选目录时工作区是
`<文档>/deepseek-harness/default-workspace`，要核对时先看会话的 `cwd`。
同一目录还有 UI 面板读取的 `notes/_state/mem0-status.json`。
阈值环境变量 `CONTEXT_GUARD_WARN/URGENT/CRITICAL`（默认 0.55/0.75/0.9，对齐套件
context_guard v1.8.0，相对上下文窗口）；`CONTEXT_GUARD_TOKENS` 可把守卫窗口压到真实
API 上限以下（路由声明的窗口比实际可用大时用）。

## 自动 Handoff / 上下文守卫 / 会话续接（对齐套件 v1.8）

dsh 侧不调用 `context_guard.py`（它依赖 CC 的 transcript JSONL），而是在 bridge 里原生实现同一套契约：

- **上下文提醒**（v1.8.0）：`tools/result` 与 `agent/turn-stopping` 都检查占用，55/75/90 三档；
  同会话同档 15 分钟节流（`CONTEXT_GUARD_THROTTLE` 可调），档位升高（含 handoff 80/90/97）立即提醒，
  回落到阈值以下或压缩后自动复位。提醒经 `agent.steer` 注入，模型下一轮可见。
- **压缩前兜底**（v1.8.0）：`compaction/start` 时绕过 15s 写节流强制刷新 checkpoint，
  达到 `CONTEXT_GUARD_HANDOFF` 再刷新 handoff——单个回合内上下文暴涨也留得下状态。
- **自动 handoff**：`agent/turn-stopping` 时按 `contextTokens / contextWindow` 计算占用，达到
  `CONTEXT_GUARD_HANDOFF`（默认 `0.8`）就由插件写
  `notes/YYYY/MM/YYYY-MM-DD-HHMM-auto-handoff.md` + `notes/_state/last-handoff.md` +
  `notes/_state/auto-handoff.json`。80/90/97% 三档，同会话同档位原地刷新，升档才新建文件。
  `agent/disposed` 再兜底一次（最后一轮可能被 15s 写节流跳过）。全程不经过模型，上下文打满也能落盘。
- **启动续接**：`agent/created` 记录会话来源；仅 `startup`/`clear` 的顶层会话（非 subagent）
  在首次 `agent/pre-step` 注入 `<上次会话自动续接>`：上次用户消息、最近操作、自动 handoff 的
  「下一步」和 checkpoint 路径。与 mem0 召回块合并成一条上下文消息，注入后不再重复。
- **状态互通**：`last-checkpoint.json` 同时写 dsh 原生字段（`steps`/`totalTokens`）和套件的
  `users`/`assistants`/`tools`/`session_id`/`md_path`；同一项目里 CC 与 dsh 可以互相从对方
  留下的 checkpoint/handoff 续接。
- 阈值可用 `CONTEXT_GUARD_HANDOFF=0.7` 提前触发、`1.0` 基本关闭。

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
- 插件文件必须位于 `~/.dsh/profiles/<profile>/plugins/` 下。dsh 只对 profile 树内的
  模块做 `@deepseek-ai/*` 导入路由；放到树外（如 `~/.mem0-claude-dsh/plugin`）时
  插件会在启动阶段 `failed to import`，桥不激活且不采集任何事件。
- **生成文件必须无 BOM**：dsh 的 skill parser 要求首行恰好是 `---`，Node 的
  `JSON.parse`（hooks.json）也拒绝 BOM；PS 5.1 的 `Set-Content -Encoding utf8`
  会写 BOM，因此安装器统一用 `Write-Utf8NoBom`（`.ps1` 仍保留 BOM）。
- **dsh 不替换 `$ARGUMENTS`**：`dsh-tool-skill` 在 pre-step 只注入 skill 正文，
  用户消息原样进模型（`/name 参数` 也是原文）。因此 dsh 侧 skills 已改成
  「用户消息里 `/name` 之后的文字」措辞；Claude Code 侧仍用 `$ARGUMENTS`，
  两边不再共用同一份措辞。
- 状态栏/通知：dsh 无系统通知 API；P9 的 client 插件提供右栏面板与会话头状态指示，
  任务完成提醒由 dsh 自带 completion-reminder 承担。
- **跨侧记忆互通取决于 `metadata.project` 标签。** 套件按「工作目录名」打标并在召回时
  只保留同项目记忆。dsh 未选目录时工作区是 `.../deepseek-harness/default-workspace`，
  标签会是 `default-workspace`，与 Claude CLI 侧（按仓库目录名打标）对不上，互相召回为空。
  要在同一项目共享，应在 dsh 里把工作区设为项目目录本身。
- bridge 的 `apiUrl` 以环境变量覆盖 `config.json`；改服务地址时两处都要改（或用安装器重装）。
