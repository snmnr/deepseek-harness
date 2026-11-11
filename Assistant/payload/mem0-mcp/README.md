# mem0-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A small MCP server that wraps a self-hosted [mem0](https://mem0.ai) REST API
(see `../server-compose-files/ai-containers`) as tools for Claude Desktop /
Claude Code. Mem0's own official MCP integrations (`mcp.mem0.ai`, the archived
`mem0-mcp-server` package) only target Mem0's cloud API — different auth
scheme (`Authorization: Token ...` vs. this server's `X-API-Key`) and
different routes — so they don't work against a self-hosted instance. This
wraps the self-hosted REST API directly instead.

## Tools

| Tool | mem0 endpoint |
|---|---|
| `add_memory` | `POST /memories` |
| `search_memories` | `POST /search` |
| `list_memories` | `GET /memories` |
| `get_memory` | `GET /memories/{id}` |
| `update_memory` | `PUT /memories/{id}` |
| `delete_memory` | `DELETE /memories/{id}` |

Bulk operations (`delete_all_memories`, `/reset`) are intentionally not
exposed — keeps the blast radius of an LLM-driven tool call small. Use `curl`
directly against the API for those.

## Setup

Requires an API key from the mem0 dashboard (`/setup` on first run, or the
API Keys page after) and the URL your machine can reach the mem0 API at.

Add to Claude Desktop's config
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS).
Two ways to run it, depending on whether you've cloned the repo:

**Without cloning**, straight from GitHub — same `uvx --from git+...` pattern
other MCP servers use to run from a repo without publishing to PyPI first:

```bash
uvx --from git+https://github.com/andresmorales07/mem0-mcp mem0-mcp
```

```json
{
  "mcpServers": {
    "mem0": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/andresmorales07/mem0-mcp", "mem0-mcp"],
      "env": {
        "MEM0_API_URL": "http://your-mem0-host:8888",
        "MEM0_API_KEY": "m0sk_...",
        "MEM0_DEFAULT_USER_ID": "your-user-id",
        "MEM0_DEFAULT_AGENT_ID": "claude-desktop"
      }
    }
  }
}
```

Prefer to pin to a released version instead of tracking `main`? Append a ref,
e.g. `git+https://github.com/andresmorales07/mem0-mcp@v0.1.0`.

**From a local clone:**

```json
{
  "mcpServers": {
    "mem0": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/mem0-mcp", "mem0-mcp"],
      "env": {
        "MEM0_API_URL": "http://your-mem0-host:8888",
        "MEM0_API_KEY": "m0sk_...",
        "MEM0_DEFAULT_USER_ID": "your-user-id",
        "MEM0_DEFAULT_AGENT_ID": "claude-desktop"
      }
    }
  }
}
```

Use the full path to `uv`/`uvx` (e.g. `which uv`) if Claude Desktop can't find
them on its own `PATH`.

Both default env vars are optional, and they behave differently:

- `MEM0_DEFAULT_USER_ID` is a last-resort fallback — only used when a tool
  call supplies no `user_id`, `agent_id`, or `run_id` at all. Applies to both
  reads and writes.
- `MEM0_DEFAULT_AGENT_ID` is merged in **only on `add_memory`** (unless that
  call passes its own `agent_id`), tagging every memory this server writes
  with which client created it — useful if you ever point another tool (n8n,
  a different agent) at the same mem0 instance and want to tell them apart
  later.

  It's deliberately **not** applied to `search_memories`/`list_memories`. MCP
  tool calls can't distinguish "no agent_id given" from "search across all
  agents," so auto-tagging reads would silently and permanently scope every
  query to just this one agent — making it impossible to ever ask "show me
  everything anyone has learned about me" again. Reads default to whatever
  `user_id`/`agent_id`/`run_id` the model explicitly passes (plus the
  `MEM0_DEFAULT_USER_ID` fallback above); pass `agent_id` explicitly on a read
  if you want to narrow it to one agent's memories.

Restart Claude Desktop after editing the config. Claude will prompt for
permission the first time it calls one of these tools.

## Manual test

```bash
MEM0_API_URL=http://your-mem0-host:8888 MEM0_API_KEY=m0sk_... uv run python -c "
from mem0_mcp.server import list_memories
print(list_memories(user_id='alice'))
"
```
