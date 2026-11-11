# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-tool-module MCP server (`src/mem0_mcp/server.py`) that wraps a **self-hosted** mem0
REST API as tools for Claude Desktop / Claude Code. Mem0's official MCP integrations only target
Mem0's cloud API (different auth header, different routes), so this exists to talk to a
self-hosted instance instead (see the sibling `../server-compose-files/ai-containers` repo for
that deployment).

Packaged as an installable console script (`mem0-mcp`, via `[project.scripts]` in
`pyproject.toml`) rather than a loose script, so it can be run the way most MCP servers are —
`uvx --from git+<repo-url> mem0-mcp` without cloning, or `uv run --directory <path> mem0-mcp`
from a local clone.

## Commands

```bash
uv sync                      # install dependencies into .venv
uv run mem0-mcp               # run the MCP server directly (stdio transport)

# Manual smoke test against a running mem0 instance:
MEM0_API_URL=http://dockerhost.home:8888 MEM0_API_KEY=m0sk_... uv run python -c "
from mem0_mcp.server import list_memories
print(list_memories(user_id='alice'))
"
```

There is no test suite, linter, or build step configured — verification is the manual smoke
test above, or exercising the tools through Claude Desktop/Code directly.

Required env vars (server raises `RuntimeError` at import time if missing):
- `MEM0_API_URL` — base URL of the self-hosted mem0 API
- `MEM0_API_KEY` — an `m0sk_...` key from the mem0 dashboard

Optional env vars: `MEM0_DEFAULT_USER_ID`, `MEM0_DEFAULT_AGENT_ID` (see scoping rules below).

## Architecture

Everything lives in `src/mem0_mcp/server.py`: an `httpx.Client` configured with the mem0 API's
`X-API-Key` auth, wrapped by `FastMCP` tool functions that each map 1:1 to a mem0 REST endpoint
(`add_memory` → `POST /memories`, `search_memories` → `POST /search`, etc.). Bulk-delete
endpoints (`delete_all_memories`, `/reset`) are intentionally **not** exposed as tools, to keep
the blast radius of an LLM-driven tool call small — use `curl` directly against the API for
those.

The one piece of real logic is `_identifiers()`, which merges the caller-supplied
`user_id`/`agent_id`/`run_id` with the two default env vars. The defaults are **asymmetric by
design** and this asymmetry is load-bearing, not an oversight:

- `MEM0_DEFAULT_USER_ID` is a last-resort fallback applied to **both reads and writes**, only
  when a call supplies no `user_id`/`agent_id`/`run_id` at all.
- `MEM0_DEFAULT_AGENT_ID` is merged in **only on writes** (`add_memory`, via `tag_agent=True`),
  and only if the call didn't pass its own `agent_id`. It tags memories with which MCP client
  wrote them (useful once multiple tools point at the same mem0 instance).
- It is deliberately **never** auto-applied on `search_memories`/`list_memories`. An MCP tool
  call can't distinguish "caller passed no agent_id" from "caller wants to search across all
  agents" — auto-tagging reads would silently and permanently scope every query to one agent,
  making a cross-agent search impossible. If you touch `_identifiers()` or add a new read tool,
  preserve this: reads must not inherit `MEM0_DEFAULT_AGENT_ID`.

When adding a new tool that talks to a new mem0 endpoint, follow the existing pattern: build the
body/params via `_identifiers()` (passing `tag_agent=True` only for writes), call the endpoint
through the shared `client`, then run the response through `_raise_for_status()` before
returning `response.json()`.
