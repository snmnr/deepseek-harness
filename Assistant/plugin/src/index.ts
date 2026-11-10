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

import { fireHookCommand, captureHookStdout, runHookCommand, basePayload, type BridgeConfig } from './capture.ts'
import {
  CheckpointState,
  WarnThrottle,
  contextLimit,
  guardBand,
  guardLevel,
  handoffBandPercent,
  handoffThreshold,
  readResumeContext,
  writeAutoHandoff,
  writeCheckpoint,
} from './checkpoint.ts'
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
  /** Same-session/same-band warning throttle (context_guard.py v1.8.0). */
  warn: WarnThrottle
  /** Set after the first recall flag is written for this session id. */
  cwd: string | undefined
  /**
   * Serializes assistant captures so the Stop flush observes the final
   * message; without it the two hook subprocesses race on the same buffer and
   * the stop hook can read one event short of the threshold.
   */
  capture: Promise<unknown>
  /** A fresh top-level session may resume from the previous checkpoint. */
  resumeEligible: boolean
  /** Set once the checkpoint/handoff files have been read (even if empty). */
  resumeChecked: boolean
  /** The `<上次会话自动续接>` block, when a previous checkpoint exists. */
  resumeText: string | undefined
  /** Set after the resume block was folded into a model step. */
  resumeInjected: boolean
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
        warn: new WarnThrottle(),
        cwd,
        capture: Promise.resolve(),
        resumeEligible: false,
        resumeChecked: false,
        resumeText: undefined,
        resumeInjected: false,
      }
      states.set(sid, st)
    }
    return st
  }

  /**
   * Steer a context-pressure reminder into the agent, the dsh equivalent of
   * `context_guard.py warn` (55/75/90 bands, same 15-minute per-session
   * throttle). Called from tool results (long tool-only turns) and from the
   * turn-stopping boundary; the shared throttle prevents duplicates, while a
   * raised band (guard or handoff) is delivered immediately.
   */
  function maybeWarn(agent: Agent, st: SessionState, tokens: number, window: number): void {
    const band = guardBand(tokens, window)
    if (!band) {
      st.warn.reset()
      return
    }
    const ratio = tokens / window
    if (st.warn.check(Math.max(band, handoffBandPercent(ratio))) === undefined) return
    const pct = Math.round(ratio * 100)
    const usedK = Math.round(tokens / 1000)
    const limitK = Math.round(window / 1000)
    const tail = ratio >= handoffThreshold()
      ? '已达到自动 handoff 档位，建议立即收尾或运行 /handoff。'
      : '可运行 /handoff，或先收尾当前任务。'
    try {
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: `<system-reminder>上下文约 ${pct}%（${usedK}k/${limitK}k）。${tail}</system-reminder>` } satisfies ContentBlock] as ContentBlock[],
        source: CONTEXT_SOURCE,
      }))
    } catch {
      // A disposed or read-only agent must not break the tool/stop pipeline.
    }
  }

  // --- SessionStart → agent/created (serial, awaited): rescue stale buffers + resume ---
  ctx.on('agent/created', ({ agent, source }) => {
    const st = stateFor(agent)
    const header = agent.session.header
    // A fresh top-level session resumes what the previous one left behind.
    // `resume` means the persisted session was loaded with its own history;
    // `compact` continues the same conversation; subagents inherit the parent.
    st.resumeEligible = (source === 'startup' || source === 'clear') && header.origin !== 'subagent'
    const payload = {
      ...basePayload(String(header.id), st.cwd, 'SessionStart'),
      // CC source vocabulary: startup | resume | clear | compact. dsh's
      // compaction-recovery path maps to 'compact' → the wrapper flushes.
      source: source === 'compact' ? 'compact' : source === 'resume' ? 'resume' : 'startup',
    }
    fireHookCommand(resolved, 'session-start', payload, log)
    // Seed the UI status file so the right-panel tab has data immediately.
    void writeStatusFile(st.cwd, String(header.id), resolved, log)
  })

  // --- UserPromptSubmit → agent/pre-step: capture prompt + recall on first prompt ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    const st = stateFor(agent)
    const sid = String(agent.session.header.id)
    const text = blocksToText(messages.flatMap(m => m.content))
    st.checkpoint.beginTurn(turn, text || undefined)
    st.exportBuffer.addUser(text, Date.now())
    if (st.resumeEligible && !st.resumeChecked && !st.resumeInjected) {
      st.resumeText = await readResumeContext(st.cwd, sid)
      st.resumeChecked = true
    }
    const payload = { ...basePayload(sid, st.cwd, 'UserPromptSubmit'), prompt: text }
    const recalled = await captureHookStdout(resolved, 'user-prompt', payload, log)
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    // Only the first model step carries the resume block; later turns would
    // otherwise re-inject it every time the recall hook returns text.
    const resume = st.resumeInjected ? undefined : st.resumeText
    const parts = [resume, recalled].filter((part): part is string => Boolean(part))
    if (st.resumeEligible) {
      st.resumeInjected = true
      st.resumeText = undefined
    }
    if (parts.length === 0) return downstream
    const context = createUserMessage({
      content: [{ type: 'text', text: parts.join('\n\n') } satisfies ContentBlock] as ContentBlock[],
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
    // context_guard v1.8.0 also checks on PostToolUse: a turn that runs tools
    // for hours without a new prompt must still learn that the window is
    // filling. The throttle keeps this to one reminder per band.
    if (config.checkpoints !== false) {
      maybeWarn(agent, st, contextTokensOf(ctx, agent), contextWindowOf(agent))
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
        st.capture = st.capture
          .then(() => runHookCommand(resolved, 'assistant', { ...basePayload(sid, st.cwd, 'Stop'), text }, log))
          .catch(() => undefined)
      }
      return
    }
    if (event.type === 'compaction/start') {
      // PreCompact equivalent: flush mem0, and (kit v1.8.0) force a checkpoint
      // before history is compressed away. The forced write bypasses the 15s
      // throttle so a turn that fills the window still leaves resumable state.
      const window = contextLimit(sessionWindowOf(session))
      const tokens = sessionTokensOf(ctx, session)
      const ratio = window > 0 ? tokens / window : 0
      const finish = (): void => {
        fireHookCommand(resolved, 'flush', basePayload(sid, st?.cwd, 'PreCompact'), log)
        if (!st || config.checkpoints === false) return
        st.warn.reset()
        void (async () => {
          if (!st.checkpoint.shouldWrite(true)) return
          await writeCheckpoint(st.cwd ?? process.cwd(), sid, st.checkpoint.snapshot())
          if (session.header.origin !== 'subagent' && st.cwd && ratio >= handoffThreshold()) {
            await writeAutoHandoff(st.cwd, sid, st.checkpoint.snapshot(), ratio)
          }
        })().catch(() => undefined)
      }
      if (st) void st.capture.then(finish)
      else finish()
    }
  })

  // --- Stop flush trigger + checkpoint → agent/turn-stopping (serial) ---
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const st = stateFor(agent)
    const sid = String(agent.session.header.id)
    // The assistant capture must land before Stop reads the buffer; the two
    // run as separate python subprocesses with no shared lock, so firing Stop
    // immediately can miss the turn's final message and skip the flush.
    await st.capture
    const payload = { ...basePayload(sid, st.cwd, 'Stop'), stop_hook_active: false }
    fireHookCommand(resolved, 'stop', payload, log)
    // Guard metric is the CURRENT context occupancy (tokenMeter.measure), not
    // the cumulative billed usage the ring buffer accumulates; the window comes
    // from the route the session last resolved.
    const window = contextWindowOf(agent)
    const contextTokens = contextTokensOf(ctx, agent)
    if (config.checkpoints !== false) {
      // Warn on its own throttle (not the checkpoint write throttle): a turn
      // boundary is also the natural place to repeat a still-current warning
      // after the 15-minute window has elapsed.
      maybeWarn(agent, st, contextTokens, window)
      if (st.checkpoint.shouldWrite()) {
        await writeCheckpoint(st.cwd ?? process.cwd(), sid, st.checkpoint.snapshot())
        // Deterministic handoff: the model cannot be relied on once the context
        // is near full, so the bridge writes the same 80/90/97% bands itself.
        if (agent.session.header.origin !== 'subagent' && st.cwd && window > 0) {
          void writeAutoHandoff(st.cwd, sid, st.checkpoint.snapshot(), contextTokens / window)
        }
      }
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
  ctx.on('agent/disposed', async ({ agent }) => {
    const sid = String(agent.session.header.id)
    const st = states.get(sid)
    await st?.capture
    // Last chance to land a handoff for a high-context session (the turn-stop
    // write is throttled and may not have run for the final turn).
    if (config.checkpoints !== false && st?.cwd && agent.session.header.origin !== 'subagent') {
      const window = contextWindowOf(agent)
      const ratio = window > 0 ? contextTokensOf(ctx, agent) / window : 0
      if (ratio >= handoffThreshold()) {
        await writeAutoHandoff(st.cwd, sid, st.checkpoint.snapshot(), ratio)
      }
    }
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
function sessionWindowOf(session: Session): number {
  try {
    return session.requestContext()?.contextWindow ?? 0
  } catch {
    return 0
  }
}

/** Effective guard window: the route window, capped by `CONTEXT_GUARD_TOKENS`. */
function contextWindowOf(agent: Agent): number {
  return contextLimit(sessionWindowOf(agent.session))
}

/** Tokens currently occupying the session context (tokenMeter; 0 when absent). */
function sessionTokensOf(ctx: Context, session: Session): number {
  try {
    const meter = ctx.get('tokenMeter') as { measure?: (session: unknown) => { totalTokens?: number } } | undefined
    const measured = meter?.measure?.(session)
    return typeof measured?.totalTokens === 'number' ? measured.totalTokens : 0
  } catch {
    return 0
  }
}

function contextTokensOf(ctx: Context, agent: Agent): number {
  return sessionTokensOf(ctx, agent.session)
}

function defaultHooksScript(): string {
  return join(homedir(), '.mem0-claude-dsh', 'hooks', 'mem0_hooks_dsh.py')
}

function defaultDataDir(): string {
  return join(homedir(), '.dsh', 'mem0')
}
