---
name: handoff
description: 生成交接记录（下班/换机器前用）
---
为当前项目生成一份可续接的 handoff 笔记。

1. 收集当前状态（非 git 仓库跳过）：
   - `git status --short`
   - `git diff --stat`
   - `git log --oneline -5`
2. 写 `notes/YYYY/MM/YYYY-MM-DD-handoff.md`（本地日期，目录不存在就创建），frontmatter：

   ```yaml
   ---
   source: llm
   kind: handoff
   date: YYYY-MM-DD
   ---
   ```

3. 正文只写继续工作必需的内容：
   - 已完成（可验证的结果）
   - 下一步（按优先级，可执行）
   - 阻塞 / 待确认
   - 关键命令与文件
   - 决策与原因（只写会影响后续的）
4. 不贴大段代码；需要时写文件路径和关键行。
5. 项目根有 `.affine-docs.config.json` 时文档发布 hook 会自动发布；否则提醒用 `/publish-project-docs`。
6. 最后回复文件路径 + 3 行摘要。
