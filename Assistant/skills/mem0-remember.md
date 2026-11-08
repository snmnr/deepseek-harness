---
name: mem0-remember
description: 写记忆：记住这件事。用法：/mem0-remember <要记住的话>
---
调用 `mcp__mem0__add_memory`，把用户消息里 `/mem0-remember` 之后的内容存入长期记忆
（dsh 不替换占位符，直接读原始消息；不要把 `/mem0-remember` 这个命令词写进记忆）。

写入契约（design-patch-001）：
- 先判断 category，只能是：偏好 / 事实 / 事件 / 进度 / 待办 / 经验 / 决策 / 目标 / 人际。
- 显式传 `infer=false`（用户已给出明确事实，原样存，不再抽取）。
- 传 `metadata`：
  - category、status="active"、source="user_stated"、confidence=0.9
  - project：当前项目名；不确定用 "general"
  - 事实 / 偏好 / 决策：valid_from=今天（Asia/Shanghai，YYYY-MM-DD）
  - 事件：event_date=事情发生日；相对时间（昨天/上周三/下周一）先换算成 YYYY-MM-DD
  - 待办：due=YYYY-MM-DD（工具会自动补 due_ts）
- 工具会先 search top_k=3；若返回 `skipped=true`（相似度 >0.92），先告诉用户已存在，
  不要重复写。用户确认要更新时，用返回的 duplicate.id 作为 `supersede_id` 再写一次，
  并附 `supersede_reason`。
- 完成后回显 mem0 返回的 memory 文本，说明是新增、已存在还是已替代。
