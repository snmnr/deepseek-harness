---
name: archive-docs
description: 把已发布文档按年/月归档到 AFFiNE。用法：/archive-docs [--dry-run] [--project <名称>] [--pattern <前缀>]
---
运行归档器，把当前项目已发布到 AFFiNE 的文档按 `YYYY/MM` 归档：

```powershell
node "{{ARCHIVE}}" . $ARGUMENTS
```

用法：

- 先 `--dry-run` 预览要移动的文档；
- 确认后去掉 `--dry-run` 执行；
- `--project <名称>` 指定 AFFiNE 项目文件夹（默认读 `.affine-docs.config.json`）；
- `--pattern notes/` 只归档某个前缀下的文档。

归档是**原地移动** AFFiNE 文档（docId 不变），同时移动本地文件、更新 manifest 和蒸馏台账。
完成后用 `/publish-project-docs --preview` 确认全部 `skipped`，不要改文档内容。
