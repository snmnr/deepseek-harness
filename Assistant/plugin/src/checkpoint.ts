/**
 * Progress-guard checkpoint, rewritten for dsh: instead of parsing a transcript
 * JSONL file (context_guard.py's Claude Code approach), the bridge keeps a
 * per-session in-memory ring buffer fed by `session/event` and writes the
 * checkpoint on the turn-stopping boundary. Real token usage comes from the
 * `assistant/message` event's `usage` field instead of file-size estimation.
 * @module checkpoint
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** One ring-buffer step summary (the checkpoint's building block). */
export interface StepRecord {
  turn: number
  /** First ≤300 chars of the user text for this turn. */
  user?: string
  /** First ≤400 chars of the last assistant text for this turn. */
  assistant?: string
  /** Up to 20 `tool name + args preview` entries. */
  tools: string[]
  /** Real token usage accumulated from assistant/message events. */
  tokens: number
  time: number
}

const MAX_STEPS = 40
const MAX_USER_CHARS = 300
const MAX_ASSISTANT_CHARS = 400
const MAX_TOOLS = 20
const MAX_TOOL_PREVIEW_CHARS = 160
/** Minimum interval between checkpoint writes on the same session. */
const WRITE_THROTTLE_MS = 15_000

/** In-memory per-session capture state. */
export class CheckpointState {
  readonly steps: StepRecord[] = []
  private current: StepRecord | undefined
  private currentTurn = -1
  private totalTokens = 0
  private lastWriteAt = 0

  beginTurn(turn: number, userText: string | undefined): void {
    if (turn !== this.currentTurn) {
      this.current = { turn, tools: [], tokens: 0, time: Date.now(), ...(userText ? { user: userText.slice(0, MAX_USER_CHARS) } : {}) }
      this.currentTurn = turn
      this.steps.push(this.current)
      if (this.steps.length > MAX_STEPS) this.steps.shift()
    } else if (userText && this.current && !this.current.user) {
      this.current.user = userText.slice(0, MAX_USER_CHARS)
    }
  }

  recordAssistant(text: string, usageTokens: number | undefined): void {
    if (this.current) {
      this.current.assistant = text.slice(0, MAX_ASSISTANT_CHARS)
      if (usageTokens) {
        this.current.tokens += usageTokens
        this.totalTokens += usageTokens
      }
    }
  }

  recordTool(name: string, argsPreview: string): void {
    if (!this.current) return
    if (this.current.tools.length >= MAX_TOOLS) return
    const preview = argsPreview.length > MAX_TOOL_PREVIEW_CHARS ? argsPreview.slice(0, MAX_TOOL_PREVIEW_CHARS) + '…' : argsPreview
    this.current.tools.push(`${name}: ${preview}`)
  }

  get tokens(): number {
    return this.totalTokens
  }

  /** Whether a checkpoint write is due (throttled). */
  shouldWrite(): boolean {
    const now = Date.now()
    if (now - this.lastWriteAt < WRITE_THROTTLE_MS) return false
    this.lastWriteAt = now
    return this.steps.length > 0
  }

  snapshot(): { steps: StepRecord[]; totalTokens: number } {
    return { steps: [...this.steps.map(s => ({ ...s, tools: [...s.tools] }))], totalTokens: this.totalTokens }
  }
}

/** Thresholds as fractions of the context window (env-overridable). */
function thresholds(): { warn: number; urgent: number; critical: number } {
  const num = (name: string, def: number): number => {
    const v = Number.parseFloat(process.env[name] ?? '')
    return Number.isFinite(v) && v > 0 && v < 1 ? v : def
  }
  return { warn: num('CONTEXT_GUARD_WARN', 0.6), urgent: num('CONTEXT_GUARD_URGENT', 0.75), critical: num('CONTEXT_GUARD_CRITICAL', 0.9) }
}

/** Guard level for the current pressure, or undefined below warn. */
export function guardLevel(tokens: number, window: number): 'warn' | 'urgent' | 'critical' | undefined {
  if (window <= 0) return undefined
  const r = tokens / window
  const t = thresholds()
  if (r >= t.critical) return 'critical'
  if (r >= t.urgent) return 'urgent'
  if (r >= t.warn) return 'warn'
  return undefined
}

/** Render the checkpoint markdown (same shape as context_guard.py writes). */
export function renderCheckpointMarkdown(cwd: string, state: { steps: StepRecord[]; totalTokens: number }, time: Date): string {
  const lines: string[] = [
    '# 自动 Checkpoint（dsh mem0-dsh-bridge）',
    '',
    `> 生成时间: ${time.toISOString()}　工作目录: ${cwd}　累计 tokens: ${state.totalTokens}`,
    '',
    '## 摘要',
    '',
  ]
  const last = state.steps.at(-1)
  if (last?.assistant) lines.push(last.assistant)
  else if (last?.user) lines.push(`最近用户输入: ${last.user}`)
  else lines.push('（暂无内容）')
  lines.push('', '## 近期步骤', '')
  for (const s of state.steps.slice(-10).reverse()) {
    lines.push(`### Turn ${s.turn}`)
    if (s.user) lines.push(`- 用户: ${s.user.replace(/\n+/g, ' ')}`)
    if (s.assistant) lines.push(`- 助手: ${s.assistant.replace(/\n+/g, ' ')}`)
    for (const t of s.tools.slice(0, 5)) lines.push(`- 工具: ${t}`)
    lines.push(`- tokens: ${s.tokens}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Write the checkpoint files. Prefers `<cwd>/notes/_state/`, falls back to
 * `~/.dsh/state/checkpoints/<cwd-slug>/` when the project dir is not writable.
 */
export async function writeCheckpoint(
  cwd: string,
  sessionId: string,
  state: { steps: StepRecord[]; totalTokens: number },
): Promise<string | undefined> {
  const now = new Date()
  const json = JSON.stringify({
    sessionId,
    cwd,
    generatedAt: now.toISOString(),
    totalTokens: state.totalTokens,
    steps: state.steps,
  }, null, 2)
  const md = renderCheckpointMarkdown(cwd, state, now)
  const candidates: Array<{ dir: string; label: string }> = [
    { dir: resolve(cwd, 'notes', '_state'), label: 'project' },
    {
      dir: join(homedir(), '.dsh', 'state', 'checkpoints', cwd.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'default'),
      label: 'home-fallback',
    },
  ]
  for (const c of candidates) {
    try {
      await mkdir(c.dir, { recursive: true })
      await writeFile(join(c.dir, 'last-checkpoint.json'), json, 'utf8')
      await writeFile(join(c.dir, 'last-checkpoint.md'), md, 'utf8')
      return join(c.dir, 'last-checkpoint.md')
    } catch {
      // try next candidate
    }
  }
  return undefined
}
