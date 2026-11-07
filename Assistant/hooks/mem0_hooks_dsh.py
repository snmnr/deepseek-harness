#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mem0 hooks 的 dsh（deepseek-harness）包装层。

原脚本（mem0-claude-kit payload/mem0_hooks.py）零改动，本文件按路径加载它，
复用其全部函数；只在外层：
  - 新增 assistant 子命令（dsh 原生插件经 session/event 捕获的助手结论）
  - 新增 ui-status 子命令（供 UI 面板轮询的 JSON 状态）
  - 数据目录经环境变量 MEM0_DATA_DIR 覆写（与 Claude CLI 安装的数据隔离）
  - 后台落盘改走本包装层（保证 detach 子进程同样用 MEM0_DATA_DIR）

配置优先级（与原脚本一致）：环境变量 > config.json > 默认值。
子命令：在原脚本全部子命令基础上新增 assistant / ui-status。
"""

import json
import os
import sys

# ---------- 定位并加载原脚本（零改动） ----------
def _locate_original() -> str:
    # 1) 显式环境变量（install-dsh.ps1 写入系统环境或由插件 spawn 时注入）
    env_path = os.environ.get("MEM0_HOOKS_ORIGINAL")
    if env_path and os.path.isfile(env_path):
        return env_path
    # 2) dsh 侧默认安装位置（install-dsh.ps1 复制原件到此）
    default = os.path.join(
        os.path.expanduser("~"), ".mem0-claude-dsh", "original", "mem0_hooks.py"
    )
    if os.path.isfile(default):
        return default
    raise FileNotFoundError(
        "mem0_hooks.py 原脚本未找到：设置 MEM0_HOOKS_ORIGINAL 或确认 "
        "~/.mem0-claude-dsh/original/mem0_hooks.py 存在（由 install-dsh.ps1 复制）"
    )


def _load_original(path: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location("mem0_hooks_original", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载原脚本: {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_original = _load_original(_locate_original())

# ---------- 数据目录覆写（不改原文件，改模块常量） ----------
# 原脚本 import 时已按旧 DATA_DIR 构建了 CONFIG_PATH / PAUSE_PATH 常量，
# 这里统一覆写；环境变量同时会传给 detach 子进程（原脚本支持
# MEM0_FLUSH_MIN_EVENTS 等 env，但 DATA_DIR 是模块常量，所以由本层覆盖）。
_DATA_DIR = os.environ.get("MEM0_DATA_DIR") or os.path.join(
    os.path.expanduser("~"), ".dsh", "mem0"
)
os.makedirs(_DATA_DIR, exist_ok=True)
_original.DATA_DIR = _DATA_DIR
_original.CONFIG_PATH = os.path.join(_DATA_DIR, "config.json")
_original.PAUSE_PATH = os.path.join(_DATA_DIR, "paused")

# dsh 侧连接配置：原脚本 import 时按旧路径读过一次 config，这里覆写路径后
# 必须重新加载，否则会读到 Claude CLI 侧 ~/.claude/mem0/config.json 的参数。
# 优先级与原脚本一致：环境变量 > dsh 侧 config.json > 原脚本 import 时的值。
_CFG_DSH = _original._load_config()
_original.API_URL = (
    os.environ.get("MEM0_API_URL") or _CFG_DSH.get("api_url") or _original.API_URL or "http://127.0.0.1:8888"
).rstrip("/")
_original.API_KEY = os.environ.get("MEM0_API_KEY") or _CFG_DSH.get("api_key") or _original.API_KEY or ""
_original.USER_ID = (
    os.environ.get("MEM0_DEFAULT_USER_ID") or _CFG_DSH.get("user_id") or _original.USER_ID or "me"
)

# ---------- 后台落盘改走本包装层 ----------
# 原脚本 _spawn_detached 用 sys.executable + os.path.abspath(__file__) 拉起
# flush-detached —— __file__ 指向原脚本，detach 子进程会以旧 DATA_DIR 运行。
# 这里替换为指向本包装层，使后台进程继承 MEM0_DATA_DIR。
def _spawn_detached_dsh(sid: str) -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)
    log_path = os.path.join(_DATA_DIR, "last-flush.log")
    import subprocess
    import time

    kwargs = {"stdin": subprocess.DEVNULL, "close_fds": True}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    with open(log_path, "ab") as log:
        log.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} flush {sid} ===\n".encode("utf-8"))
        log.flush()
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "flush-detached", sid],
            stdout=log,
            stderr=log,
            **kwargs,
        )


_original._spawn_detached = _spawn_detached_dsh


# ---------- dsh 专属子命令 ----------
# 写入契约与原 stop() 一致：assistant 结论走 _append + events[-1] 去重。
_MAX_ASSISTANT_CHARS = int(os.environ.get("MEM0_MAX_ASSISTANT_CHARS", "4000"))


def _assistant() -> None:
    """stdin: {session_id, cwd, text} —— dsh 原生插件捕获的助手最终文本。"""
    data = _original._stdin()
    sid = _original._sid(data)
    text = (data.get("text") or "").strip()
    if not text or _original._paused():
        return
    if len(text) > _MAX_ASSISTANT_CHARS:
        text = text[:_MAX_ASSISTANT_CHARS]
    buf = _original._read_buffer(sid)
    events = buf["events"]
    if not (events and events[-1].get("type") == "assistant" and events[-1].get("content") == text):
        buf["project"] = buf.get("project") or _original._project(data)
        events.append({"type": "assistant", "content": text})
        _original._write_buffer(sid, buf["project"], events)


def _ui_status() -> None:
    """供 UI 面板轮询的 JSON 状态：缓冲、暂停、最近 flush、服务地址。"""
    import time

    buffers = []
    try:
        for name in os.listdir(_DATA_DIR):
            if name.startswith("buffer_") and name.endswith(".json"):
                sid = name[len("buffer_"):-len(".json")]
                buf = _original._read_buffer(sid)
                buffers.append({
                    "session": sid[:16],
                    "project": buf.get("project") or "-",
                    "pending": len(buf["events"]),
                    "mtime": int(os.path.getmtime(os.path.join(_DATA_DIR, name)) * 1000),
                })
    except OSError:
        pass
    paused_file = os.path.join(_DATA_DIR, "paused")
    log_path = os.path.join(_DATA_DIR, "last-flush.log")
    last_flush = None
    try:
        last_flush = int(os.path.getmtime(log_path) * 1000)
    except OSError:
        pass
    print(json.dumps({
        "api_url": _original.API_URL,
        "user_id": _original.USER_ID,
        "paused": os.path.exists(paused_file),
        "paused_at": (open(paused_file, encoding="utf-8").read().strip() if os.path.exists(paused_file) else None),
        "data_dir": _DATA_DIR,
        "last_flush_at": last_flush,
        "checked_at": int(time.time() * 1000),
        "pending_buffers": buffers,
    }, ensure_ascii=False))


_DSH_COMMANDS = {
    "assistant": _assistant,
    "ui-status": _ui_status,
}

_COMMANDS = dict(getattr(_original, "_COMMANDS", {}))
_COMMANDS.update(_DSH_COMMANDS)


def main() -> None:
    # Windows 默认按系统代码页输出，dsh 按 UTF-8 读取 → 强制 UTF-8（同原脚本）
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    fn = _COMMANDS.get(cmd)
    if fn:
        try:
            fn()
        except Exception as e:  # hook 出错绝不能阻塞会话
            print(f"mem0 dsh hook {cmd} 失败: {e}", file=sys.stderr)
    sys.exit(0)


if __name__ == "__main__":
    main()
