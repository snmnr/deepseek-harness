# 移植与隐私约定（mem0-claude-kit → dsh）

本文件规定 `Assistant/` 如何跟着 mem0-claude-kit 更新，以及**每次移植都必须保持的隐私处理**。
新增功能或同步新版前先读这里。

## 1. 边界

- `mem0-claude-kit` 是**只读来源**，任何情况下不在套件目录里改代码或设计。
- dsh 侧的改动只能落在 `Assistant/`：
  - 原脚本（`mem0_hooks.py`）通过 `hooks/mem0_hooks_dsh.py` 按路径加载，只覆写模块常量/后台入口；
  - 依赖 transcript 的能力（checkpoint、handoff、上下文守卫）在 `plugin/src/` 里原生重写；
  - 工具副本（`tools/*.mjs`）可以同步套件新版，再叠加 dsh 适配。
- 两侧数据隔离：`~/.mem0-claude`（Claude CLI） vs `~/.mem0-claude-dsh`（dsh）；
  `~/.claude/mem0` vs `~/.dsh/mem0`。

## 2. 同步流程

1. 看套件 `VERSION` 与最近修改时间，确认哪些文件变了。
2. 用 dsh 运行时副本当上一版基线做 diff（比直接和 `Assistant/` 比更准，后者已有 dsh 适配）：
   - `~/.mem0-claude-dsh/original/mem0_hooks.py`
   - `~/.mem0-claude-dsh/tools/*.mjs`
   - `~/.mem0-claude/context_guard.py`（Claude 侧安装副本）
3. 按差异移植：
   - `mem0_hooks.py` 新版：通常重装即可（安装器只读复制）；若新增模块常量/后台入口，先在
     `hooks/mem0_hooks_dsh.py` 里补覆写，避免写回 Claude 侧数据目录。
   - `context_guard.py` 新版：把行为移植到 `plugin/src/checkpoint.ts` / `index.ts`
     （dsh 用真实 token 与事件，不读 transcript）。
   - `tools/*.mjs` 新版：同步后**重新套用隐私占位处理**（见第 3 节）。
4. 跑 `install-dsh.ps1` 更新运行时，然后执行第 4 节验证。
5. 提交前跑第 3.6 节的隐私扫描；提交邮箱必须是 GitHub noreply。

## 3. 隐私处理（强制）

公开仓库里不允许出现真实凭据、个人路径、内网地址或工作区标识。

### 3.1 凭据

- 不写真实 API key / token / 密码 / 私钥；示例统一 `m0sk_xxx`、`<token>`。
- 凭据只放 `~/.dsh/.credentials.yaml`、`~/.dsh/mem0/config.json`、环境变量；
  代码里只允许 `${credential:MEM0_API_KEY}` 这类引用。

### 3.2 个人路径与用户名

- 禁止 `C:\Users\<真实用户名>`、`D:\Working\...` 等本机路径。
- 示例用 `C:/Users/your-name/...`、`D:/path/to/deepseek-harness/...`；
  能用相对路径或 `$PSScriptRoot` 推导的就不要写死。

### 3.3 内网地址与工作区

- 禁止真实内网域名/IP（你自己的公司/家庭域名也算）。
- 默认值用保留示例域名：`https://affine.example.com:4430`、`https://mem0.example.com:4430`。
- `workspaceId` 默认留空，缺失时明确报错并提示配置位置；不要写真实 UUID。
- 真实地址/工作区放在 `%USERPROFILE%\.affine-docs\config.json` 或环境变量：
  `AFFINE_MCP_URL` / `AFFINE_WEB_BASE` / `AFFINE_WORKSPACE_ID`。

### 3.4 用户标识

- 示例/默认用 `me`；说明「同一 mem0 服务下用同一个 id 才共享长期记忆」，
  不写真实姓名或别人的 id。

### 3.5 会话沉淀

- 根目录 `notes/` 已被 `.gitignore` 的 `/notes/` 忽略（只忽略根目录，不影响 `.agents/notes/`）。
- checkpoint/handoff/蒸馏产物、`notes/_state/*.json`、日志、缓冲一律不提交。
- 导出/状态文件（`~/.affine-docs`、`~/.dsh`、`~/.mem0-claude-dsh`）都在仓库外。

### 3.6 提交与历史

- `git config user.email` 必须是 `<id>+<username>@users.noreply.github.com`，
  并开启 GitHub 的 “Keep my email addresses private”。
- 提交前扫描（应无输出）：

```powershell
git grep -n -I -E "m0sk_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_|BEGIN [A-Z ]*PRIVATE KEY" -- Assistant
git grep -n -I -E "C:[/\\]Users[/\\][A-Za-z]+|[Dd]:[/\\]Working" -- Assistant
```

再人工确认没有你自己的真实内网域名/工作区 ID（不要把真实值写进本文件或扫描命令，
否则它们本身就成了泄露源）。`C:/Users/your-name` 这类示例占位符命中是正常的；
出现真实用户名、`D:\Working\...` 或真实域名才需要改掉。

- 若历史里已经泄露：用 `git filter-repo --email-callback` 改写作者/提交者邮箱，
  `force-with-lease` 推自己的 fork；要彻底清除旧对象，**删除并重建远端仓库**，
  再把改写后的 `master` 重新推上去。不要用 `--no-verify` 绕过检查。

## 4. 验证清单

移植后至少确认：

```powershell
# 语法/模块
node --check Assistant/tools/*.mjs
node --import tsx/esm -e "import('./Assistant/plugin/src/checkpoint.ts')"

# 包装层链路（不启动 dsh）
python ~/.mem0-claude-dsh/hooks/mem0_hooks_dsh.py doctor
python ~/.mem0-claude-dsh/hooks/mem0_hooks_dsh.py status
python ~/.mem0-claude-dsh/hooks/mem0_hooks_dsh.py report --dry-run

# 启动器
.\Assistant\start-dsh.ps1 -Check
```

- 运行时 `~/.mem0-claude-dsh/original/VERSION` 应与套件一致；
- `doctor` 的「hook 注册」应显示 9 个事件齐全（dsh 用 profile 里的 bridge 判断）；
- 上报配置不得继承 Claude 侧：`report --dry-run` 的 `kit_version` 正确，
  未配置时 `REPORT_URL` 为空；
- `notes/` 仍不进入 `git status`。

## 5. 变更记录

| 套件版本 | 移植内容 |
|---|---|
| 1.7.23 | `context_guard` v1.8.0（55/75/90 档、PostToolUse 检查、PreCompact 强制 checkpoint、`CONTEXT_GUARD_TOKENS`）；`mem0_hooks` 1.7.22（doctor/report/dead-letter/flush 锁）；tools 生命周期布局、指针去重、`--plan-layout/--reconcile` |
| 1.7.24 | `_post` 连接失败重试（`MEM0_FLUSH_ATTEMPTS`，默认 3 次，仅连接类错误）；`retry-pending` 子命令与 `report-detached` 顺带补落盘（`MEM0_RETRY_MIN_AGE_SECONDS`，默认 60s）；上报新增 `pending_oldest_minutes`、`last_flush_error_age_minutes` |
