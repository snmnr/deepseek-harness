---
name: publish-project-docs
description: 发布当前项目下的 md 到 AFFiNE（通用项目发布器）。用法：/publish-project-docs [--preview] [--all] ...
---
运行通用 AFFiNE 文档发布器，扫描**当前项目目录**（当前工作目录）。
参数 = 用户消息里 `/publish-project-docs` 之后的文字；没有参数就不加：

```powershell
node "{{TOOL}}" .
```

常用参数：

- `--preview`：预览，只列出会上传/更新的文档，不写 AFFiNE
- `--all`：忽略 hash 强制重写
- `--project <名称>`：指定 AFFiNE 项目文件夹名（默认取目录名）
- `--include <glob>` / `--exclude <glob>`：缩小/排除扫描范围
- `--flat`：不保留子目录

发布范围也可以写在项目根 `.affine-docs.config.json`（字段：`project` / `include` / `exclude` / `flat`）。
配置优先级：环境变量 `AFFINE_*` > `~/.affine-docs/config.json` > 内置默认值。

用中文汇报 `files / created / updated / skipped / errors`；预览模式下列出 `changes`。不要修改文档内容本身。
