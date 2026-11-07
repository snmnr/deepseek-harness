<!-- mem0-dsh:begin v1 -->
## 长期记忆（mem0 × dsh）

- 与本用户/本项目相关的背景、偏好、历史决策，可先用 `mcp__mem0__search_memories` 查一下再回答。
- 用户说「记住…」「以后都…」时，用 `mcp__mem0__add_memory` 写入（写入契约见 /mem0-remember skill）。
- 记忆属于跨会话的长期信息，不要把当次对话的临时细节写进去。
- 会话结束时 mem0-dsh-bridge 会自动沉淀缓冲；`/mem0-status` 查看状态，`/mem0-pause` 暂停采集。
- 文档发布/蒸馏：`/publish-project-docs`、`/distill`、`/distill-history`、`/handoff`、`/dsh-resume`。
<!-- mem0-dsh:end -->
