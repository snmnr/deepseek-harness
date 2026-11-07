---
name: distill
description: 把当前对话蒸馏成长期笔记
---
把**当前会话**蒸馏成一份可复用笔记，写到 `notes/YYYY/MM/<slug>.md`（按年/月分目录），frontmatter：

```yaml
---
source: llm
kind: distill
date: YYYY-MM-DD
---
```

正文包含：

- 背景与目标
- 结论与决策（带原因）
- 产出与改动（文件路径/命令，不贴大段代码）
- 未决问题
- 可复用经验（坑、判断规则）

要求：只保留有长期价值的信息，不写寒暄和过程流水账。写完后提示发布状态。
