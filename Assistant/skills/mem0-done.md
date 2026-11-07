---
name: mem0-done
description: 完成待办：标记 done 并写完成事件。用法：/mem0-done <待办关键词>
---
按顺序执行：

1. 用 `mcp__mem0__search_memories` 搜索 `$ARGUMENTS`（top_k=10）。
2. 只保留 `metadata.category="待办"` 且 `metadata.status="active"` 的候选，
   列出 id、内容、due，**等用户确认要完成哪一条**。
3. 用户确认后调用 `mcp__mem0__complete_todo`，传 `todo_id`；
   用户给了备注就传 `note`。
4. 回显：`status=done`、`completed_at`、完成事件文本。
   如果返回 `already_done=true`，说明这条之前已经完成过，不要重复写。
