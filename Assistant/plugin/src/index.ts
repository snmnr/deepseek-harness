/**
 * mem0-dsh-bridge: a native dsh plugin that ports mem0-claude-kit's memory
 * loop (auto recall + auto consolidation) onto harness events. The Python
 * side (mem0_hooks_dsh.py wrapping the unmodified kit script) owns buffering,
 * redaction, and flushing; this plugin only translates harness events into
 * wrapper subcommands and injects recall context on the first prompt.
 *
 * Event mapping (CC hook → dsh point):
 *   SessionStart            → agent/created (serial, awaited)
 *   UserPromptSubmit        → agent/pre-step (waterfall; recall folded into enter decision)
 *   PostToolUse             → tools/result (emit, isError=false)
 *   PostToolUseFailure      → tools/result (emit, isError=true) — the CC bridge lacks this
 *   Stop (transcript grab)  → session/event assistant/message — the CC bridge lacks a path
 *   PreCompact              → session/event compaction/start — the CC bridge lacks this
 *   Stop (flush trigger)    → agent/turn-stopping (serial)
 *   SessionEnd              → agent/disposed (emit) + distill export
 *   SubagentStart/Stop      → subagent/start|end (emit; child text arrives via the
 *                             global session/event listener)
 * @module mem0-dsh-bridge
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mem0-dsh-bridge': { kind: 'mem0-dsh-bridge' } & ContextFormed
  }
}

import { fireHookCommand, captureHookStdout, basePayload, type BridgeConfig } from './capture.ts'
import { CheckpointState, guardLevel, writeCheckpoint } from './checkpoint.ts'
import { ExportBuffer, writeExport } from './export.ts'
import { writeStatusFile, type UiStatusExtra } from './status.ts'

export const name = 'mem0-dsh-bridge'

export interface Config {
  /** Python executable used to spawn the wrapper (default: `python`). */
  python?: string
  /** Absolute path to mem0_hooks_dsh.py (default: <pluginDir>/../hooks/mem0_hooks_dsh.py). */
  hooksScript?: string
  /** mem0 data dir (default: ~/.dsh/mem0). */
  dataDir?: string
  /** mem0 API URL override (optional; config.json / env otherwise). */
  apiUrl?: string
  /** API key override — normally injected via ${credential:MEM0_API_KEY} in the patch. */
  apiKey?: string
  /** mem0 user id override (optional). */
  userId?: string
  /** Hook subcommand timeout in ms (default 30000). */
  timeoutMs?: number
  /** Exports root for distillation JSONL (default ~/.mem0-claude-dsh/exports). */
  exportsDir?: string
  /** Enable checkpoint writing (default true). */
  checkpoints?: boolean
  /** Enable distill export on disposal (default true). */
  distillExport?: boolean
}

export const Config: z<Config> = z.object({
  python: z.string().default('python'),
  hooksScript: z.string(),
  dataDir: z.string(),
  apiUrl: z.string(),
  apiKey: z.string(),
  userId: z.string(),
  timeoutMs: z.number().default(30_000),
  exportsDir: z.string(),
  checkpoints: z.boolean().default(true),
  distillExport: z.boolean().default(true),
})

/** The `{kind:'mem0-dsh-bridge'}` producer source stamped on injected context. */
const CONTEXT_SOURCE = { kind: 'mem0-dsh-bridge' } as const

interface SessionState {
  checkpoint: CheckpointState
  exportBuffer: ExportBuffer
  /** Set after the first recall flag is written for this session id. */
  cwd: string | undefined
}

export function apply(ctx: Context, config: Config): void {
  const resolved: BridgeConfig = {
    python: config.python ?? 'python',
    hooksScript: config.hooksScript ?? defaultHooksScript(),
    dataDir: config.dataDir ?? defaultDataDir(),
    ...(config.apiUrl !== undefined ? { apiUrl: config.apiUrl } : {}),
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.userId !== undefined ? { userId: config.userId } : {}),
    timeoutMs: config.timeoutMs ?? 30_000,
  }
  const log = (msg: string): void => ctx.logger.warn(msg)
  const states = new Map<string, SessionState>()

  function stateFor(agent: Agent): SessionState {
    const sid = String(agent.session.header.id)
    let st = states.get(sid)
    if (!st) {
      const cwd = agent.session.header.cwd
      st = {
        checkpoint: new CheckpointState(),
        exportBuffer: new ExportBuffer(cwd),
        cwd,
      }
      states.set(sid, st)
    }
    return st
  }

  // --- SessionStart → agent/created (serial, awaited): rescue stale buffers ---
  ctx.on('agent/created', ({ agent, source }) => {
    const st = stateFor(agent)
    const payload = {
      ...basePayload(String(agent.session.header.id), st.cwd, 'SessionStart'),
      // CC source vocabulary: startup | resume | clear | compact. dsh's
      // compaction-recovery path maps to 'compact' → the wrapper flushes.
      source: source === 'compaction' ? 'compact' : source === 'resume' ? 'resume' : 'startup',
    }
    fireHookCommand(resolved, 'session-start', payload, log)
    // Seed the UI status file so the right-panel tab has data immediately.
    void writeStatusFile(st.cwd, String(agent.session.header.id), resolved, log)
  })

  // --- UserPromptSubmit → agent/pre-step: capture prompt + recall on first prompt ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    const st = stateFor(agent)
    const sid = String(agent.session.header.id)
    const text = blocksToText(messages.flatMap(m => m.content))
    st.checkpoint.beginTurn(turn, text || undefined)
    st.exportBuffer.addUser(text, Date.now())
    const payload = { ...basePayload(sid, st.cwd, 'UserPromptSubmit'), prompt: text }
    const recalled = await captureHookStdout(resolved, 'user-prompt', payload, log)
    const downstream = await next()
    if (!recalled || downstream.kind !== 'enter') return downstream
    const context = createUserMessage({
      content: [{ type: 'text', text: recalled } satisfies ContentBlock] as ContentBlock[],
      source: CONTEXT_SOURCE,
    })
    return { ...downstream, messages: [...downstream.messages, context] }
  })

  // --- PostToolUse / PostToolUseFailure → tools/result (emit) ---
  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    const agent = exec.agent
    if (!agent) return
    const st = stateFor(agent)
    const sid = String(agent.session.header.id)
    const argsPreview = safeJsonPreview(exec.arguments)
    st.checkpoint.recordTool(exec.name, argsPreview)
    st.exportBuffer.addTool(exec.name, argsPreview)
    if (result.isError) {
      const reason = result.error.info?.reason ?? result.error.message
      fireHookCommand(resolved, 'post-tool-failure', {
        ...basePayload(sid, st.cwd, 'PostToolUseFailure'),
        tool_name: exec.name,
        tool_input: exec.arguments,
        error: (reason ?? 'tool error').slice(0, 600),
      }, log)
    } else {
      fireHookCommand(resolved, 'post-tool', {
        ...basePayload(sid, st.cwd, 'PostToolUse'),
        tool_name: exec.name,
        tool_input: exec.arguments,
      }, log)
    }
  })

  // --- Assistant conclusions + compaction flush + token metering (global feed) ---
  // A global (non-agent-scoped) listener sees child/subagent sessions too, so
  // subagent conclusions reach the buffer without extra wiring.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const sid = String(session.header.id)
    const st = states.get(sid)
    if (event.type === 'assistant/message') {
      const text = blocksToText(event.data.message.content)
      const tokens = usageTokens(event.data.usage)
      if (st && text) {
        st.checkpoint.recordAssistant(text, tokens)
        st.exportBuffer.addAssistant(text, event.time)
      }
      // Buffering the assistant conclusion is fire-and-forget; the wrapper
      // dedupes against the previous assistant event (same contract as CC's stop()).
      if (text && st) {
        fireHookCommand(resolved, 'assistant', { ...basePayload(sid, st.cwd, 'Stop'), text }, log)
      }
      return
    }
    if (event.type === 'compaction/start') {
      // PreCompact equivalent: flush before history is compressed away.
      fireHookCommand(resolved, 'flush', basePayload(sid, st?.cwd, 'PreCompact'), log)
    }
  })

  // --- Stop flush trigger + checkpoint → agent/turn-stopping (serial) ---
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const st = stateFor(agent)
    const sid = String(agent.session.header.id)
    const payload = { ...basePayload(sid, st.cwd, 'Stop'), stop_hook_active: false }
    fireHookCommand(resolved, 'stop', payload, log)
    // Guard metric is the CURRENT context occupancy (tokenMeter.measure), not
    // the cumulative billed usage the ring buffer accumulates; the window comes
    // from the route the session last resolved.
    const window = contextWindowOf(agent)
    const contextTokens = contextTokensOf(ctx, agent)
    if (config.checkpoints !== false && st.checkpoint.shouldWrite()) {
      const level = guardLevel(contextTokens, window)
      if (level) {
        // Fold a warning into the next step via steer — the model sees it and
        // can wrap up or surface it to the user (mirrors context_guard warn).
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `<system-reminder>上下文占用${level === 'critical' ? '已接近上限' : '较高'}（约 ${contextTokens} tokens）。建议尽快收尾或 /handoff。</system-reminder>` } satisfies ContentBlock] as ContentBlock[],
          source: CONTEXT_SOURCE,
        }))
      }
      await writeCheckpoint(st.cwd ?? process.cwd(), sid, st.checkpoint.snapshot())
    }
    // Refresh the UI status file at every turn boundary (buffer depth, pause
    // state, guard level). Session-end erases it below.
    void writeStatusFile(st.cwd, sid, resolved, log, {
      tokens: st.checkpoint.tokens,
      contextTokens,
      guardLevel: guardLevel(contextTokens, window) ?? null,
    })
  })

  // --- SessionEnd + distill export → agent/disposed (emit) ---
  ctx.on('agent/disposed', ({ agent }) => {
    const sid = String(agent.session.header.id)
    const st = states.get(sid)
    fireHookCommand(resolved, 'session-end', basePayload(sid, st?.cwd, 'SessionEnd'), log)
    // Mark the UI status file ended (the panel shows a tombstone until the
    // workspace file channel reports the change).
    if (st?.cwd !== undefined) {
      void writeStatusFile(st.cwd, sid, resolved, log, { ended: true } satisfies UiStatusExtra & { ended: boolean }).catch(() => {})
    }
    if (config.distillExport !== false && st && !st.exportBuffer.isEmpty) {
      void writeExport(sid, st.exportBuffer, {
        ...(config.exportsDir !== undefined ? { exportsDir: config.exportsDir } : {}),
      }).then(path => {
        if (path) ctx.logger.info?.(`mem0-dsh-bridge: distill export written: ${path}`)
        states.delete(sid)
      }).catch(error => {
        log(`mem0-dsh-bridge: distill export failed: ${String(error)}`)
      })
    } else {
      states.delete(sid)
    }
  })

  // --- Subagent lifecycle → subagent-start/stop subcommands (emit) ---
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    if (!child) return
    const sid = String(child.session.header.id)
    fireHookCommand(resolved, 'subagent-start', {
      ...basePayload(sid, child.session.header.cwd, 'SubagentStart'),
      agent_id: info.id,
      agent_type: 'general-purpose',
    }, log)
  })
  ctx.on('subagent/end', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    const sid = String(child?.session.header.id ?? info.id)
    fireHookCommand(resolved, 'subagent-stop', {
      ...basePayload(sid, child?.session.header.cwd, 'SubagentStop'),
      agent_id: info.id,
      agent_type: 'general-purpose',
      // No child transcript path exists in dsh; the child's assistant text was
      // already captured by the global session/event listener.
      agent_transcript_path: '',
    }, log)
  })
}

// ---------- helpers ----------

function blocksToText(content: readonly { type: string; text?: string }[]): string {
  return content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

function usageTokens(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const u = usage as Record<string, unknown>
  const t = u.totalTokens ?? u.total_tokens
  return typeof t === 'number' && Number.isFinite(t) ? t : undefined
}

function safeJsonPreview(args: unknown): string {
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args)
    return (s ?? '').slice(0, 160)
  } catch {
    return '(unserializable args)'
  }
}

/** Context window size from the route the session resolved (0 → guard disabled). */
function contextWindowOf(agent: Agent): number {
  try {
    return agent.session.requestContext()?.contextWindow ?? 0
  } catch {
    return 0
  }
}

/** Tokens currently occupying the session context (tokenMeter; 0 when absent). */
function contextTokensOf(ctx: Context, agent: Agent): number {
  try {
    const meter = ctx.get('tokenMeter') as { measure?: (session: unknown) => { totalTokens?: number } } | undefined
    const measured = meter?.measure?.(agent.session)
    return typeof measured?.totalTokens === 'number' ? measured.totalTokens : 0
  } catch {
    return 0
  }
}

function defaultHooksScript(): string {
  return join(homedir(), '.mem0-claude-dsh', 'hooks', 'mem0_hooks_dsh.py')
}

function defaultDataDir(): string {
  return join(homedir(), '.dsh', 'mem0')
}
