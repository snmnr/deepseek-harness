import os
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from mcp.server.fastmcp import FastMCP

MEM0_API_URL = os.environ.get("MEM0_API_URL", "").rstrip("/")
MEM0_API_KEY = os.environ.get("MEM0_API_KEY", "")
MEM0_DEFAULT_USER_ID = os.environ.get("MEM0_DEFAULT_USER_ID") or None
MEM0_DEFAULT_AGENT_ID = os.environ.get("MEM0_DEFAULT_AGENT_ID") or None

if not MEM0_API_URL:
    raise RuntimeError("MEM0_API_URL is required, e.g. http://dockerhost.home:8888")
if not MEM0_API_KEY:
    raise RuntimeError("MEM0_API_KEY is required (an m0sk_... key from the mem0 dashboard)")

client = httpx.Client(
    base_url=MEM0_API_URL,
    headers={"X-API-Key": MEM0_API_KEY, "Content-Type": "application/json"},
    timeout=30,
)

mcp = FastMCP("mem0")

# ---------------------------------------------------------------------------
# 写入契约（design-patch-001 / memory-spec）
#
# 按类别集中在这里，避免魔数散落。d/β 等 ACT-R 参数在 memory-spec §3 的表里，
# 本文件只负责写入时的默认 salience / pinned / quadrant 与时间字段。
# ---------------------------------------------------------------------------
TIMEZONE_NAME = "Asia/Shanghai"
LOCAL_TZ = timezone(timedelta(hours=8))  # Asia/Shanghai, no DST
DEDUP_TOP_K = 3
DEDUP_THRESHOLD = 0.92

CATEGORY_POLICY: dict[str, dict[str, Any]] = {
    # category: {quadrant, salience, pinned}
    "偏好": {"quadrant": "semantic", "salience": 0.8, "pinned": True},
    "事实": {"quadrant": "semantic", "salience": 0.5, "pinned": False},
    "事件": {"quadrant": "episodic", "salience": 0.3, "pinned": False},
    "进度": {"quadrant": "prospective", "salience": 0.5, "pinned": False},
    "待办": {"quadrant": "prospective", "salience": 0.4, "pinned": False},
    "经验": {"quadrant": "procedural", "salience": 0.6, "pinned": False},
    "决策": {"quadrant": "semantic", "salience": 0.8, "pinned": True},
    "目标": {"quadrant": "semantic", "salience": 0.8, "pinned": True},
    "人际": {"quadrant": "semantic", "salience": 0.8, "pinned": True},
}

# design-patch-001 §C：这三类需要 valid_from；未显式给出时默认 = 写入当天（本地）。
VALID_FROM_CATEGORIES = {"事实", "偏好", "决策"}

SOURCE_CONFIDENCE = {"user_stated": 0.9, "tool_confirmed": 0.8, "ai_inferred": 0.6}


def _identifiers(
    user_id: Optional[str],
    agent_id: Optional[str],
    run_id: Optional[str],
    tag_agent: bool = False,
) -> dict[str, str]:
    """Merge explicit scope with defaults.

    tag_agent=True (writes only) applies MEM0_DEFAULT_AGENT_ID unless the
    caller passes its own agent_id - it tags every memory with which MCP
    server wrote it. It must stay off for reads (list/search): since MCP tool
    calls can't distinguish "no agent_id given" from "search across all
    agents", auto-tagging reads would silently and permanently scope every
    query to this one agent, making it impossible to ever search a user's
    memories across agents again.

    MEM0_DEFAULT_USER_ID always applies as a last resort, when the caller
    supplies no user_id/run_id - reads and writes both benefit from a sane
    default "who is this" scope.
    """
    ids = {k: v for k, v in {"user_id": user_id, "agent_id": agent_id, "run_id": run_id}.items() if v}
    if tag_agent and "agent_id" not in ids and MEM0_DEFAULT_AGENT_ID:
        ids["agent_id"] = MEM0_DEFAULT_AGENT_ID
    if "user_id" not in ids and "run_id" not in ids and MEM0_DEFAULT_USER_ID:
        ids["user_id"] = MEM0_DEFAULT_USER_ID
    if not ids:
        raise ValueError("Provide at least one of user_id, agent_id, or run_id.")
    return ids


def _raise_for_status(response: httpx.Response) -> None:
    if response.is_error:
        try:
            detail = response.json().get("detail", response.text)
        except Exception:
            detail = response.text
        raise RuntimeError(f"mem0 API error ({response.status_code}): {detail}")


def _local_today() -> str:
    return datetime.now(LOCAL_TZ).date().isoformat()


def _normalize_metadata(metadata: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Fill the write-contract defaults; caller-supplied values always win."""
    meta = dict(metadata or {})
    meta.setdefault("timezone", TIMEZONE_NAME)
    meta.setdefault("event_date", None)
    meta.setdefault("valid_from", None)
    meta.setdefault("valid_to", None)
    meta.setdefault("usage_times", [])
    meta.setdefault("status", "active")
    meta.setdefault("project", "general")

    category = meta.get("category")
    policy = CATEGORY_POLICY.get(category) if category else None
    if policy:
        meta.setdefault("quadrant", policy["quadrant"])
        meta.setdefault("salience", policy["salience"])
        meta.setdefault("pinned", policy["pinned"])

    # 事实/偏好/决策：valid_from 未给时 = 写入当天（本地）。历史事实可显式覆盖。
    if category in VALID_FROM_CATEGORIES and not meta.get("valid_from"):
        meta["valid_from"] = _local_today()

    # 待办：由 due 推导数值镜像，供 lte/gt 范围过滤。
    if category == "待办" and meta.get("due") and meta.get("due_ts") is None:
        try:
            meta["due_ts"] = int(str(meta["due"]).replace("-", ""))
        except ValueError:
            pass

    source = meta.get("source") or "user_stated"
    meta["source"] = source
    if "confidence" not in meta:
        meta["confidence"] = SOURCE_CONFIDENCE.get(source, 0.7)
    return meta


def _find_duplicate(
    text: str,
    scope: dict[str, str],
    category: Optional[str],
) -> Optional[dict[str, Any]]:
    """Search the same scope (and category, if given) for a >0.92 duplicate.

    Only used on the infer=false path; system enumeration never calls this.
    """
    filters: dict[str, Any] = {**scope, "status": "active"}
    if category:
        filters["category"] = category
    # 关键：mem0 /search 的 `score` 是 semantic+bm25+entity 归一化后的混合分，
    # 精确匹配也只有 ~0.5，不能拿它和 0.92 比。`threshold` 才门控 semantic_score。
    response = client.post(
        "/search",
        json={
            "query": text,
            "filters": filters,
            "top_k": DEDUP_TOP_K,
            "threshold": DEDUP_THRESHOLD,
            "explain": True,
        },
    )
    _raise_for_status(response)
    for item in response.json().get("results", []):
        # 服务器的 threshold 已按 semantic_score 过滤；这里再兜底一次（兼容旧版/异常）。
        semantic = (item.get("score_details") or {}).get("semantic_score")
        if semantic is not None and float(semantic) < DEDUP_THRESHOLD:
            continue
        if category:
            found_category = (item.get("metadata") or {}).get("category")
            if found_category not in (None, category):
                continue
        return item
    return None


@mcp.tool()
def add_memory(
    text: str,
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
    infer: bool = False,
    supersede_id: Optional[str] = None,
    supersede_reason: Optional[str] = None,
) -> dict[str, Any]:
    """Store a memory under the write contract.

    infer=False (default) is for already-refined facts: manual /mem0:remember,
    n8n/D-02 write-back. It runs a dedup search first (top_k=3, same scope and
    category, similarity > 0.92) and skips duplicates; pass supersede_id to
    replace one instead. infer=True is for raw conversation/context (hooks,
    Dify conversational addMemory) and does not dedup.

    metadata may contain category/status/project/due/due_ts/source/confidence/
    event_date/valid_from; missing contract defaults are filled. usage_times is
    never touched here - explicit adoption uses record_memory_usage().
    """
    ids = _identifiers(user_id, agent_id, run_id, tag_agent=True)
    meta = _normalize_metadata(metadata)

    duplicate = None
    if not infer:
        duplicate = _find_duplicate(text, ids, meta.get("category"))
        if duplicate and not supersede_id:
            return {"skipped": True, "reason": "duplicate", "duplicate": duplicate}

    if supersede_id:
        # Anti-hallucination: the id must exist; only real memories can be superseded.
        target = client.get(f"/memories/{supersede_id}")
        _raise_for_status(target)
        meta["supersedes"] = supersede_id
        meta["reason"] = supersede_reason or "manual update"

    body = {
        "messages": [{"role": "user", "content": text}],
        **ids,
        "metadata": meta,
        "infer": infer,
    }
    response = client.post("/memories", json=body)
    _raise_for_status(response)
    result = response.json()

    if supersede_id:
        results = result.get("results") or []
        new_id = results[0].get("id") if results else None
        if new_id:
            old_patch = {
                "status": "superseded",
                "superseded_by": new_id,
                "reason": meta["reason"],
                "valid_to": _local_today(),
            }
            old = client.put(f"/memories/{supersede_id}", json={"metadata": old_patch})
            _raise_for_status(old)
            result["superseded"] = {"id": supersede_id, "superseded_by": new_id}
    return result


@mcp.tool()
def record_memory_usage(memory_id: str) -> dict[str, Any]:
    """Append the current time to a memory's usage_times (ACT-R adoption signal).

    Call only on explicit user adoption ("对/就这个/完成", or a click confirm).
    Never call from search/enumeration paths (morning report, patrol, weekly
    scan) - that would keep B_i rising forever and break decay/archiving.
    """
    response = client.get(f"/memories/{memory_id}")
    _raise_for_status(response)
    meta = response.json().get("metadata") or {}
    times = list(meta.get("usage_times") or [])
    times.append(datetime.now(timezone.utc).isoformat())
    updated = client.put(f"/memories/{memory_id}", json={"metadata": {"usage_times": times}})
    _raise_for_status(updated)
    # mem0 PUT 返回的是 "{message: ...}"，不回显记忆；再 GET 一次返回最新状态
    refreshed = client.get(f"/memories/{memory_id}")
    _raise_for_status(refreshed)
    return refreshed.json()


@mcp.tool()
def complete_todo(todo_id: str, note: Optional[str] = None) -> dict[str, Any]:
    """Complete a 待办 under the agreed semantics (design R7, option 1).

    Steps (idempotent):
    1. Validate the memory is category=待办 and status=active.
    2. Create an 事件 memory "完成待办：..." with event_date=today,
       source=tool_confirmed, completed_todo_id=<todo_id>.
    3. PUT the todo metadata status=done, completed_at=<UTC ISO>,
       completed_event_id=<event id>, overdue=false.

    A previous completion event found via completed_todo_id is reused, so a
    retried call does not create duplicates. Supersede is NOT used for
    completion; it is reserved for fact updates.
    """
    response = client.get(f"/memories/{todo_id}")
    _raise_for_status(response)
    todo = response.json()
    meta = todo.get("metadata") or {}
    if meta.get("category") != "待办":
        raise ValueError(f"memory {todo_id} is not a 待办 (category={meta.get('category')!r})")
    if meta.get("status") == "done":
        return {
            "already_done": True,
            "todo_id": todo_id,
            "completed_at": meta.get("completed_at"),
            "completed_event_id": meta.get("completed_event_id"),
        }
    if meta.get("status") != "active":
        raise ValueError(f"only active todos can be completed (status={meta.get('status')!r})")

    scope = {k: todo.get(k) for k in ("user_id", "agent_id", "run_id") if todo.get(k)}
    if not scope:
        scope = _identifiers(None, None, None, tag_agent=False)

    # Idempotency: reuse a completion event already written for this todo.
    search = client.post(
        "/search",
        json={
            "query": todo.get("memory", ""),
            "filters": {**scope, "category": "事件", "status": "active", "completed_todo_id": todo_id},
            "top_k": 1,
            "threshold": 0.0,
        },
    )
    _raise_for_status(search)
    existing = (search.json().get("results") or [])
    event_id = existing[0].get("id") if existing else None
    event_text = existing[0].get("memory") if existing else None

    if not event_id:
        text = "完成待办：" + (todo.get("memory") or "").strip()
        if note:
            text += "（备注：" + note.strip() + "）"
        event_meta = {
            "category": "事件",
            "quadrant": "episodic",
            "status": "active",
            "project": meta.get("project") or "general",
            "salience": 0.3,
            "confidence": 0.9,
            "source": "tool_confirmed",
            "pinned": False,
            "timezone": TIMEZONE_NAME,
            "event_date": _local_today(),
            "valid_from": None,
            "valid_to": None,
            "due": None,
            "due_ts": None,
            "usage_times": [],
            "completed_todo_id": todo_id,
        }
        created = client.post(
            "/memories",
            json={
                "messages": [{"role": "user", "content": text}],
                **scope,
                "infer": False,
                "metadata": event_meta,
            },
        )
        _raise_for_status(created)
        results = created.json().get("results") or []
        if not results:
            raise RuntimeError("completion event creation returned no results")
        event_id = results[0]["id"]
        event_text = text

    completed_at = datetime.now(timezone.utc).isoformat()
    updated = client.put(
        f"/memories/{todo_id}",
        json={
            "metadata": {
                "status": "done",
                "completed_at": completed_at,
                "completed_event_id": event_id,
                "overdue": False,
            }
        },
    )
    _raise_for_status(updated)
    return {
        "already_done": False,
        "todo_id": todo_id,
        "status": "done",
        "completed_at": completed_at,
        "completed_event_id": event_id,
        "event_text": event_text,
    }


@mcp.tool()
def search_memories(
    query: str,
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    top_k: Optional[int] = None,
) -> dict[str, Any]:
    """Semantic search over stored memories, scoped to a user_id/agent_id/run_id.

    This is a read-only recall path: it never appends usage_times. Adoption is
    recorded separately via record_memory_usage().
    """
    body: dict[str, Any] = {"query": query, "filters": _identifiers(user_id, agent_id, run_id)}
    if top_k is not None:
        body["top_k"] = top_k
    response = client.post("/search", json=body)
    _raise_for_status(response)
    return response.json()


@mcp.tool()
def list_memories(
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    top_k: Optional[int] = None,
) -> dict[str, Any]:
    """List stored memories for a given user_id/agent_id/run_id."""
    params = _identifiers(user_id, agent_id, run_id)
    if top_k is not None:
        params["top_k"] = str(top_k)
    response = client.get("/memories", params=params)
    _raise_for_status(response)
    return response.json()


@mcp.tool()
def get_memory(memory_id: str) -> dict[str, Any]:
    """Retrieve a single memory by its id."""
    response = client.get(f"/memories/{memory_id}")
    _raise_for_status(response)
    return response.json()


@mcp.tool()
def update_memory(
    memory_id: str,
    text: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Update an existing memory's text and/or metadata. Confirm the memory_id
    with the user first if it wasn't just returned by another tool call."""
    body: dict[str, Any] = {}
    if text is not None:
        body["text"] = text
    if metadata is not None:
        body["metadata"] = metadata
    response = client.put(f"/memories/{memory_id}", json=body)
    _raise_for_status(response)
    return response.json()


@mcp.tool()
def delete_memory(memory_id: str) -> str:
    """Delete a single memory by its id. Confirm the memory_id with the user
    first if it wasn't just returned by another tool call."""
    response = client.delete(f"/memories/{memory_id}")
    _raise_for_status(response)
    return "Memory deleted successfully"


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
