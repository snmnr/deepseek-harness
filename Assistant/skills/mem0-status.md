---
name: mem0-status
description: 查状态：记忆功能正常吗
---
运行下面的命令并把输出整理成简洁状态摘要（服务地址、用户、是否暂停、待落盘缓冲数量）：

```
python "{{HOOKS}}" ui-status
```

（`{{HOOKS}}` 已由安装器替换为 mem0_hooks_dsh.py 的绝对路径。）
