---
name: mem0-doctor
description: 自检：mem0 链路哪里断了
---
运行下面的命令，把输出按 OK / WARN / FAIL 整理成一条简短结论（先说结论，再列 FAIL 与 WARN 项），不要原样贴整张表：

```
python "{{HOOKS}}" doctor
```

对每个 FAIL 项给出最可能的下一步；WARN 项只提一句要不要处理。
用户想确认「服务端嵌入到底能吃多长」时，再追加 `--deep`（会发 1~6 次只读搜索请求，不写入记忆）：

```
python "{{HOOKS}}" doctor --deep
```

（`{{HOOKS}}` 已由安装器替换为 mem0_hooks_dsh.py 的绝对路径；dsh 侧的 hook 注册检查看的是 profile 里的 mem0-dsh-bridge，不是 settings.json。）
