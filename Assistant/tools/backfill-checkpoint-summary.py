#!/usr/bin/env python3
"""给历史 checkpoint 补「## 摘要」段落。

背景：checkpoint 的标题固定为「自动 Checkpoint YYYY-MM-DD HH:MM」，本身不含主题。
换机器后只看到这个标题，无法判断当天在做什么。本脚本从已有的
「最近在做什么（用户消息）」和「最近助手结论」两个小节里各取首条，
生成两行摘要插到正文开头。

刻意不修改 H1 标题：检索排序里「标题命中」优先级最高，
把主题词写进 checkpoint 标题会让日志抢占知识文档的位置。

用法：
    python backfill-checkpoint-summary.py [项目根] [--dry-run]

幂等：已有「## 摘要」的文件会被跳过。
"""

import argparse
import re
import sys
from pathlib import Path

HEADER_TOPIC = "最近在做什么（用户消息）"
HEADER_CONCL = "最近助手结论"
SUMMARY_HEADING = "## 摘要"
SUMMARY_BLOCK_RX = re.compile(rf"^{re.escape(SUMMARY_HEADING)}\s*$\n(?:- .*\n)*", re.M)
NOTE_PREFIX = "> 由 context_guard.py"
TITLE_PREFIX = "# 自动 Checkpoint"


def clean_text(text: str) -> str:
    """去掉代码块与行内标记，与 context_guard.py 的摘要逻辑保持一致。"""
    text = re.sub(r"```[\s\S]*?```", " ", text or "")
    text = text.replace("**", "").replace("`", "")
    return re.sub(r"\s+", " ", text).strip()


def first_sentence(text: str, limit: int = 200) -> str:
    """压平空白后取首句，与 context_guard.py 的生成逻辑保持一致。"""
    text = clean_text(text)
    if not text:
        return "（未记录）"
    parts = re.split(r"(?<=[。！？；!?;])", text, maxsplit=1)
    return (parts[0] if parts else text)[:limit]


def pick_topic(items: list[str]) -> str:
    """优先取最近一条有信息量的用户消息，跳过「继续」「好的」这类短指令。"""
    for item in reversed(items or []):
        candidate = clean_text(item)
        if len(candidate) >= 12:
            return candidate[:120]
    return clean_text(items[-1])[:120] if items else ""


def section_bullets(text: str, header: str) -> list[str]:
    """取某个二级小节下的所有 `- ` 列表项（去掉前缀，保留顺序）。"""
    pattern = rf"^##\s*{re.escape(header)}\s*$(.*?)(?=^##\s|\Z)"
    m = re.search(pattern, text, re.M | re.S)
    if not m:
        return []
    out = []
    for line in m.group(1).splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            out.append(stripped[2:].strip())
    return out


def insert_after(text: str, needle_prefix: str) -> str | None:
    """在匹配行的下一行插入，返回 None 表示没找到锚点。"""
    lines = text.splitlines()
    for idx, line in enumerate(lines):
        if line.startswith(needle_prefix):
            return idx + 1
    return None


def backfill(path: Path, dry_run: bool, refresh: bool = False) -> str:
    raw = path.read_text(encoding="utf-8", errors="replace")
    had_summary = SUMMARY_HEADING in raw
    if had_summary and not refresh:
        return "skip (has summary)"
    if had_summary:
        raw = SUMMARY_BLOCK_RX.sub("\n", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)

    topics = section_bullets(raw, HEADER_TOPIC)
    concls = section_bullets(raw, HEADER_CONCL)
    topic = pick_topic(topics) or "（未记录）"
    concl = first_sentence(concls[-1], 160) if concls else "（未记录）"
    block = [
        "",
        SUMMARY_HEADING,
        f"- 本次主题：{topic}",
        f"- 最新结论：{concl}",
    ]

    idx = insert_after(raw, NOTE_PREFIX)
    if idx is None:
        idx = insert_after(raw, TITLE_PREFIX)
    if idx is None:
        return "skip (找不到插入锚点)"

    lines = raw.splitlines()
    # 锚点后紧跟空行时复用，避免连续两个空行
    tail = lines[idx:]
    if tail and tail[0].strip() == "":
        tail = tail[1:]
    new_text = "\n".join(lines[:idx] + block + [""] + tail).rstrip() + "\n"

    if not dry_run:
        path.write_text(new_text, encoding="utf-8", newline="\n")
    return "ok"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=".", help="项目根目录")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    ap.add_argument("--refresh", action="store_true", help="重算已有摘要（替换旧内容）")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    notes = root / "notes"
    if not notes.is_dir():
        print(f"找不到 notes 目录：{notes}", file=sys.stderr)
        return 2

    # rglob 已经会匹配到 _state/last-checkpoint.md，用 resolve 去重
    targets = {p.resolve() for p in notes.rglob("*-checkpoint.md")}
    latest = notes / "_state" / "last-checkpoint.md"
    if latest.exists():
        targets.add(latest.resolve())
    targets = sorted(targets)

    counts = {"ok": 0, "skip": 0}
    for path in targets:
        rel = path.relative_to(root).as_posix()
        try:
            result = backfill(path, args.dry_run, refresh=args.refresh)
        except OSError as exc:
            print(f"[error] {rel}: {exc}")
            counts["skip"] += 1
            continue
        print(f"[{result}] {rel}")
        counts["ok" if result == "ok" else "skip"] += 1

    # 控制台保持 ASCII：Windows 中文终端按 GBK 解码，中文会变乱码。
    tag = " (dry-run, nothing written)" if args.dry_run else ""
    print(f"done: updated={counts['ok']} skipped={counts['skip']}{tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
