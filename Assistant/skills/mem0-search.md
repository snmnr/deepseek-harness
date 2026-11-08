---
name: mem0-search
description: 翻记忆：搜以前记过的事。用法：/mem0-search <想搜的关键词>
---
使用 `mcp__mem0__search_memories` 工具检索长期记忆。

- query：用户消息里 `/mem0-search` 后面的文字（dsh 不替换占位符，直接读原始消息）
- top_k：8

检索完成后，用简洁列表展示最相关的至多 5 条，每条一句话，并注明是否与当前项目相关。
如果结果为空，直接说「没有找到相关记忆」。

**采纳信号（只在这时）**：如果用户随后明确说「对 / 就这个 / 完成」或点击确认某条，
调用 `mcp__mem0__record_memory_usage`，把那条的 id 传进去，追加 usage_times。
系统枚举、自动召回、早报/巡检/周整理都**不要**调用它。
