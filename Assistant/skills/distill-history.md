---
name: distill-history
description: 蒸馏历史对话（先查台账/待办，跳过已蒸馏，更新有变化的）。用法：/distill-history [sessionId | --pending | --latest N | --all] [--force]
---
历史对话先清洗再总结；**每次必须查台账，避免重复蒸馏**。
（dsh 环境：会话导出在 `~/.mem0-claude-dsh/exports/`，由 mem0-dsh-bridge 在会话结束时自动写出。）

1. 运行 `node "{{DISTILL}}" --list` 查看会话和状态（`new` / `changed` / `up-to-date`）。
2. 如果是 `--pending` 或用户没指定 sessionId：先运行 `node "{{DISTILL}}" --pending`，列出会话结束自动记录的待办会话；**优先处理这些**。没有待办时再列出最近 10 个让用户选，不要自动全量跑。
3. 对指定会话先运行 `node "{{DISTILL}}" --check <sessionId>`：
   - `up-to-date`：告诉用户已蒸馏过（显示 `note` 和 `distilledAt`），**除非用户明确要求 `--force`，否则停止**。
   - `changed`：说明源会话有更新；重新抽取，并**更新台账里的同一篇笔记**（`note` 路径），完成后重新 `--mark`。
   - `new`：正常抽取并生成新笔记。
4. 运行 `node "{{DISTILL}}" --extract <sessionId>`，读取输出目录的 `manifest.json` 和 `part-*.md`。
5. 如果 `parts > 6`，先把预计 token 和费用告诉用户，确认后再用子代理分批总结：
   - map：每片一个子代理，输出结构化要点；
   - reduce：合并成一份。
6. 写笔记（**按年/月分目录**）：
   - `new`：
     - 当前目录是 `distill-history` 专用目录（根有 `.affine-docs.config.json` 且 `project=distill-history`）→ 写 `YYYY/MM/<slug>.md`；
     - 否则写 `notes/YYYY/MM/<slug>.md`。
     - `YYYY/MM` 取会话结束时间（`manifest.endedAt`）；没有就用今天。
   - `changed`：优先覆盖 `--check` 返回的 `note` 路径；文件不存在再按上面的规则新建；
   - frontmatter：

     ```yaml
     ---
     source: llm
     kind: distill-history
     session_id: <id>
     date: YYYY-MM-DD
     ---
     ```

   正文：背景 / 结论与决策 / 产出 / 未决问题 / 可复用经验。更新时保留原有结构，只改变化部分。
7. 写完**必须**运行：
   `node "{{DISTILL}}" --mark <sessionId> --note <实际笔记路径>`
   把台账更新到当前源文件 hash。
8. 如果这个会话来自 `--pending`，再运行 `node "{{DISTILL}}" --unpend <sessionId>` 从待办队列移除。
9. 汇报：session id、状态（new/changed）、原始大小、清洗后 tokens、笔记路径。
10. `--all` 只处理 `new`/`changed`；先 `--extract-all --dry-run` 报总 token 并得到确认；`--force` 才重做 `up-to-date`。
