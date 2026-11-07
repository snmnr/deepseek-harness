---
name: mem0-forget
description: 删记忆：撕掉一条（先确认）。用法：/mem0-forget <要忘掉的关键词>
---
按顺序执行：

1. 用 `mcp__mem0__search_memories` 搜索：$ARGUMENTS（top_k=10）
2. 把候选列出来，每条给出 id 和一句话摘要，**等用户确认要删哪几条**
3. 用户确认后，才对选中的 id 调用 `mcp__mem0__delete_memory`

严禁在未确认的情况下直接删除。如果搜索没有结果，直接说明。
