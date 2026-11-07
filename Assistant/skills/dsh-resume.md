---
name: dsh-resume
description: 读取最新交接记录，恢复上次进度
---
1. 在 `notes/` 下**递归**找最新的 `*handoff*.md`（`notes/**/*handoff*.md`）；没有再找最新的 `notes/**/*.md`。
2. 同时读取（如果有）：`git log --oneline -5`、`git status --short`。
3. 用 5 行以内汇报：上次做到哪、下一步、阻塞、建议先做什么。
4. 不要重复贴 handoff 全文；只提炼当前行动所需信息。
5. 如果找不到交接记录，明确说明，并建议先跑 `/handoff`。
