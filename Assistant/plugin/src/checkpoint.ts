/**
 * Progress guard, auto handoff, and session resume, rewritten for dsh: instead
 * of parsing a transcript JSONL file (context_guard.py's Claude Code approach),
 * the bridge keeps a per-session in-memory ring buffer fed by `session/event`
 * and writes the checkpoint on the turn-stopping boundary. Real token usage
 * comes from the `assistant/message` event's `usage` field instead of
 * file-size estimation.
 *
 * On-disk state stays compatible with mem0-claude-kit's context_guard.py:
 * `last-checkpoint.json` carries `users`/`assistants`/`tools` beside the
 * dsh-native `steps`, and auto handoffs use the same
 * `notes/YYYY/MM/*-auto-handoff.md` + `notes/_state/auto-handoff.json` layout.
 * A new session in either tool can therefore resume from the other's state.
 * @module checkpoint
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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

/** Immutable view handed to the checkpoint/handoff renderers. */
export interface CheckpointSnapshot {
  steps: StepRecord[]
  totalTokens: number
  /**
   * Recent assistant replies, untruncated (up to 6 × 4k chars). Step records
   * keep only the first 400 chars, which can cut off the 下一步 list, so the
   * handoff extractor reads this buffer instead.
   */
  recentAssistantTexts: string[]
}

const MAX_STEPS = 40
const MAX_USER_CHARS = 300
const MAX_ASSISTANT_CHARS = 400
const MAX_TOOLS = 20
const MAX_TOOL_PREVIEW_CHARS = 160
const MAX_RECENT_ASSISTANTS = 6
const MAX_RECENT_ASSISTANT_CHARS = 4000
/** Minimum interval between checkpoint writes on the same session. */
const WRITE_THROTTLE_MS = 15_000
/** Auto-handoff bands (fractions of the context window), same as the kit. */
const HANDOFF_BANDS = [0.8, 0.9, 0.97] as const
/** The resume block must stay small enough to sit in a fresh prompt. */
const RESUME_MAX_CHARS = 2200

/** In-memory per-session capture state. */
export class CheckpointState {
  readonly steps: StepRecord[] = []
  private readonly recentAssistants: string[] = []
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
    const full = text.trim()
    if (full) {
      this.recentAssistants.push(full.slice(0, MAX_RECENT_ASSISTANT_CHARS))
      if (this.recentAssistants.length > MAX_RECENT_ASSISTANTS) this.recentAssistants.shift()
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

  /** Recent non-empty assistant texts, oldest first. */
  recentAssistantTexts(limit = MAX_RECENT_ASSISTANTS): string[] {
    return this.recentAssistants.slice(-limit)
  }

  /** Whether a checkpoint write is due (throttled). */
  shouldWrite(): boolean {
    const now = Date.now()
    if (now - this.lastWriteAt < WRITE_THROTTLE_MS) return false
    this.lastWriteAt = now
    return this.steps.length > 0
  }

  snapshot(): CheckpointSnapshot {
    return {
      steps: this.steps.map(s => ({ ...s, tools: [...s.tools] })),
      totalTokens: this.totalTokens,
      recentAssistantTexts: [...this.recentAssistants],
    }
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

/**
 * Auto-handoff threshold as a fraction of the context window. `1` disables it
 * in practice; the kit reads the same `CONTEXT_GUARD_HANDOFF` variable.
 * @returns The configured ratio, defaulting to `0.8`.
 */
export function handoffThreshold(): number {
  const v = Number.parseFloat(process.env.CONTEXT_GUARD_HANDOFF ?? '')
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.8
}

/** The highest configured band reached by `ratio` (0 below 80%). */
function handoffBand(ratio: number): number {
  let band = 0
  for (const b of HANDOFF_BANDS) if (ratio >= b) band = Math.round(b * 100)
  return band
}

/** `YYYY-MM-DD HH:MM` in local time (checkpoint title format, same as CC side). */
function localMinute(time: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/** `YYYY-MM-DD-HHMM` in local time (dated checkpoint/handoff file names). */
function fileStamp(time: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}-${pad(time.getHours())}${pad(time.getMinutes())}`
}

/** Local ISO-8601 with offset (`2026-11-08T13:07:55+08:00`), like the kit. */
function localIso(time: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const offset = -time.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}T${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** Flatten a message into one line and strip code/emphasis noise. */
function cleanText(text: string | undefined): string {
  if (!text) return ''
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Flatten a bullet item to one line so it cannot break the markdown list. */
function oneLine(text: string, limit = 300): string {
  return cleanText(text).slice(0, limit)
}

/** First sentence (Chinese or ASCII punctuation), capped at `limit` chars. */
function firstSentence(text: string | undefined, limit = 160): string {
  const cleaned = cleanText(text)
  if (!cleaned) return '（未记录）'
  const first = cleaned.split(/(?<=[。！？；!?;])/)[0] ?? cleaned
  return first.slice(0, limit)
}

/** The most recent informative user message, skipping short commands. */
function pickTopic(items: string[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const candidate = cleanText(items[i])
    if (candidate.length >= 12) return candidate.slice(0, 120)
  }
  return items.length > 0 ? cleanText(items[items.length - 1]).slice(0, 120) : ''
}

const NEXT_STEP_RX = /下一步|接下来|待办|未完成|剩余|还需要|需要你|等你|TODO|Next steps?|Remaining/i
const BULLET_RX = /^([-*+]|\d+[.)、])\s+/

function cleanStep(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^([-*+]|\d+[.)、])\s+/, '')
    .replace(/\*\*|`/g, '')
    .trim()
}

/**
 * Extract explicit next steps from recent assistant replies, newest first.
 * A keyword line (e.g. 「下一步：」) opens the bullet block that follows it.
 * @param texts Assistant replies, oldest first.
 * @param maxItems Maximum number of steps to return.
 * @returns Cleaned step lines, newest reply first.
 */
export function extractNextSteps(texts: string[], maxItems = 6): string[] {
  const steps: string[] = []
  const seen = new Set<string>()
  for (const text of [...texts].reverse()) {
    let active = false
    for (const line of text.split(/\r?\n/)) {
      const raw = line.trim()
      if (!raw) {
        active = false
        continue
      }
      const heading = NEXT_STEP_RX.test(raw)
      const bullet = BULLET_RX.test(raw)
      let candidate: string
      if (heading) {
        active = true
        candidate = cleanStep(raw)
        // A bare 「下一步：」 heading only opens the list; it is not a step.
        if (candidate.length < 6 || candidate.endsWith('：') || candidate.endsWith(':')) continue
      } else if (active && bullet) {
        candidate = cleanStep(raw)
      } else {
        active = false
        continue
      }
      if (candidate.length > 240 || seen.has(candidate)) continue
      seen.add(candidate)
      steps.push(candidate.slice(0, 200))
      if (steps.length >= maxItems) return steps
    }
  }
  return steps
}

/** `<cwd>` becomes a single path segment for the fallback state dir. */
function cwdSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'default'
}

/** State-dir candidates, preferred first: project tree, then `~/.dsh`. */
function stateDirCandidates(cwd: string): string[] {
  return [
    resolve(cwd, 'notes', '_state'),
    join(homedir(), '.dsh', 'state', 'checkpoints', cwdSlug(cwd)),
  ]
}

/** Render the checkpoint markdown (same shape and title as context_guard.py). */
export function renderCheckpointMarkdown(
  cwd: string,
  sessionId: string,
  state: CheckpointSnapshot,
  time: Date,
): string {
  const users = state.steps.map(s => s.user).filter((text): text is string => Boolean(text))
  const assistants = state.recentAssistantTexts.length > 0
    ? state.recentAssistantTexts
    : state.steps.map(s => s.assistant).filter((text): text is string => Boolean(text))
  const lines: string[] = [
    '---',
    'source: auto-checkpoint',
    `date: ${localIso(time)}`,
    `session: ${sessionId}`,
    `cwd: ${cwd}`,
    `est_tokens: ${state.totalTokens}`,
    '---',
    '',
    `# 自动 Checkpoint ${localMinute(time)}`,
    '',
    `> 生成时间: ${localIso(time)}　工作目录: ${cwd}　累计 tokens: ${state.totalTokens}`,
    '',
    '## 摘要',
    '',
    `- 本次主题：${pickTopic(users) || '（未记录）'}`,
    `- 最新结论：${firstSentence(assistants.at(-1))}`,
    '',
    '## 近期步骤',
    '',
  ]
  for (const s of state.steps.slice(-10).reverse()) {
    lines.push(`### Turn ${s.turn}`)
    if (s.user) lines.push(`- 用户: ${s.user.replace(/\n+/g, ' ')}`)
    if (s.assistant) lines.push(`- 助手: ${s.assistant.replace(/\n+/g, ' ')}`)
    for (const t of s.tools.slice(0, 5)) lines.push(`- 工具: ${t}`)
    lines.push(`- tokens: ${s.tokens}`)
    lines.push('')
  }
  lines.push(
    '## 恢复方式',
    '- 新会话启动时会自动注入本摘要；',
    '- 需要完整语义交接时运行 `/dsh-resume` 或 `/handoff`。',
  )
  return lines.join('\n') + '\n'
}

/**
 * Write the checkpoint files. Prefers `<cwd>/notes/_state/`, falls back to
 * `~/.dsh/state/checkpoints/<cwd-slug>/` when the project dir is not writable.
 * The JSON carries the kit's `users`/`assistants`/`tools` fields so a Claude
 * Code session in the same project can resume from a dsh checkpoint.
 * @returns The markdown path, or `undefined` when neither location is writable.
 */
export async function writeCheckpoint(
  cwd: string,
  sessionId: string,
  state: CheckpointSnapshot,
): Promise<string | undefined> {
  const now = new Date()
  const md = renderCheckpointMarkdown(cwd, sessionId, state, now)
  const users = state.steps.map(s => s.user).filter((text): text is string => Boolean(text))
  const assistants = state.recentAssistantTexts.length > 0
    ? state.recentAssistantTexts
    : state.steps.map(s => s.assistant).filter((text): text is string => Boolean(text))
  const tools = state.steps.flatMap(s => s.tools)
  for (const dir of stateDirCandidates(cwd)) {
    try {
      await mkdir(dir, { recursive: true })
      const mdPath = join(dir, 'last-checkpoint.md')
      const payload = {
        updated_at: localIso(now),
        session_id: sessionId,
        cwd,
        transcript: '',
        est_tokens: state.totalTokens,
        md_path: mdPath,
        users: users.slice(-30),
        assistants: assistants.slice(-10),
        tools: tools.slice(-30),
        // dsh-native fields for the UI and future readers.
        sessionId,
        generatedAt: localIso(now),
        totalTokens: state.totalTokens,
        steps: state.steps,
      }
      await writeFile(join(dir, 'last-checkpoint.json'), JSON.stringify(payload, null, 2), 'utf8')
      await writeFile(mdPath, md, 'utf8')
      return mdPath
    } catch {
      // try next candidate
    }
  }
  return undefined
}

/** One `auto-handoff.json` record (same fields context_guard.py writes). */
interface AutoHandoffMeta {
  updated_at?: string
  session?: string
  band?: number
  ratio?: number
  path?: string
  md_path?: string
  topic?: string
  conclusion?: string
  next_steps?: string[]
}

/**
 * Write a deterministic handoff when the context passes a band threshold.
 * The model is not involved, so a full context cannot lose the handoff.
 * Same session + same band refreshes the same file; a higher band creates a
 * new one — the kit's anti-spam rule.
 * @param cwd Session workspace (the project root for top-level sessions).
 * @param sessionId Session id used to dedupe per-session handoffs.
 * @param state Ring-buffer snapshot.
 * @param ratio Current context occupancy / context window.
 * @returns The dated handoff path, or `undefined` below threshold / on failure.
 */
export async function writeAutoHandoff(
  cwd: string,
  sessionId: string,
  state: CheckpointSnapshot,
  ratio: number,
): Promise<string | undefined> {
  if (ratio < handoffThreshold()) return undefined
  const now = new Date()
  const users = state.steps.map(s => s.user).filter((text): text is string => Boolean(text))
  const assistants = state.steps.map(s => s.assistant).filter((text): text is string => Boolean(text))
  const recentAssistants = state.recentAssistantTexts.length > 0 ? state.recentAssistantTexts : assistants
  const tools = state.steps.flatMap(s => s.tools)
  const band = handoffBand(ratio)
  const pct = Math.round(ratio * 100)
  for (const stateDir of stateDirCandidates(cwd)) {
    try {
      await mkdir(stateDir, { recursive: true })
      const metaPath = join(stateDir, 'auto-handoff.json')
      let meta: AutoHandoffMeta = {}
      try {
        meta = JSON.parse(await readFile(metaPath, 'utf8')) as AutoHandoffMeta
      } catch {
        // A missing or corrupt meta file means "no previous band yet".
        meta = {}
      }
      const inProject = resolve(stateDir) === resolve(cwd, 'notes', '_state')
      const datedDir = inProject
        ? join(cwd, 'notes', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'))
        : stateDir
      const target = meta.session === sessionId && meta.band === band && typeof meta.path === 'string'
        ? meta.path
        : join(datedDir, `${fileStamp(now)}-auto-handoff.md`)
      const latestMd = join(stateDir, 'last-handoff.md')
      const topic = pickTopic(users) || '（未记录）'
      const conclusion = firstSentence(recentAssistants.at(-1), 200)
      const nextSteps = extractNextSteps(recentAssistants, 6)
      const nextBlock = nextSteps.length > 0
        ? nextSteps.map(step => `- ${step}`).join('\n')
        : '- （未从最近回复提取到明确下一步，直接看下方「最近在做什么」）'
      const bulletBlock = (items: string[], n: number): string => {
        const lines = items.slice(-n).map(item => `- ${oneLine(item)}`)
        return lines.length > 0 ? lines.join('\n') : '- （无）'
      }
      const body = `---
source: auto-handoff
kind: handoff
date: ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}
generated_at: ${localIso(now)}
session: ${sessionId}
cwd: ${cwd}
context_ratio: ${ratio.toFixed(2)}
---

# 自动 Handoff ${localMinute(now)}

> 上下文约 ${pct}% 时由 mem0-dsh-bridge 自动生成，不依赖模型。
> 这是确定性的状态快照，不是精确的语义交接；新会话说「继续」即可接着做。

## 摘要
- 本次主题：${topic}
- 最新结论：${conclusion}

## 下一步（自动提取，需人工确认）
${nextBlock}

## 最近在做什么（用户消息）
${bulletBlock(users, 8)}

## 最近助手结论
${bulletBlock(recentAssistants, 5)}

## 最近操作
${bulletBlock(tools, 20)}

## 恢复方式
- 新会话直接说「继续」；SessionStart 会自动注入最近 checkpoint。
- 本文件：\`${target}\`
- 滚动副本：\`${latestMd}\`
`
      const text = body.slice(0, 20_000)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, text, 'utf8')
      await writeFile(latestMd, text, 'utf8')
      const payload: AutoHandoffMeta = {
        updated_at: localIso(now),
        session: sessionId,
        band,
        ratio: Number(ratio.toFixed(3)),
        path: target,
        md_path: latestMd,
        topic,
        conclusion,
        next_steps: nextSteps.slice(0, 6),
      }
      await writeFile(metaPath, JSON.stringify(payload, null, 2), 'utf8')
      await pruneDated(dirname(target), '-auto-handoff.md', 20)
      return target
    } catch {
      // try next candidate
    }
  }
  return undefined
}

/** Keep only the newest `keep` files with `suffix` in `dir`. */
async function pruneDated(dir: string, suffix: string, keep: number): Promise<void> {
  try {
    const names = (await readdir(dir)).filter(name => name.endsWith(suffix)).sort()
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      await unlink(join(dir, name))
    }
  } catch {
    // Pruning is best-effort; never block the handoff write.
  }
}

/** Shape of a `last-checkpoint.json` written by either side. */
interface CheckpointStateFile {
  updated_at?: string
  session_id?: string
  sessionId?: string
  cwd?: string
  md_path?: string
  users?: unknown
  assistants?: unknown
  tools?: unknown
  steps?: unknown
}

function stringArray(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string').slice(-limit)
}

function stepRecords(value: unknown): StepRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is StepRecord =>
    typeof item === 'object' && item !== null && Array.isArray((item as StepRecord).tools))
}

/** Windows paths compare case-insensitively; everything else verbatim. */
function samePath(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/**
 * Build the `<上次会话自动续接>` block a fresh session should see.
 * Reads the checkpoint/handoff a previous session (Claude Code or dsh) left in
 * this workspace. Only called for top-level startup/clear sessions.
 * @param cwd Session workspace.
 * @param sessionId Current session id; a checkpoint from the same session is ignored.
 * @returns The injected text, or `undefined` when no usable state exists.
 */
export async function readResumeContext(cwd: string | undefined, sessionId: string): Promise<string | undefined> {
  if (!cwd) return undefined
  for (const dir of stateDirCandidates(cwd)) {
    let state: CheckpointStateFile
    try {
      state = JSON.parse(await readFile(join(dir, 'last-checkpoint.json'), 'utf8')) as CheckpointStateFile
    } catch {
      continue
    }
    if (typeof state.cwd === 'string' && state.cwd.length > 0 && !samePath(state.cwd, cwd)) continue
    const previousSession = state.session_id ?? state.sessionId ?? ''
    // This workspace's checkpoint is our own; never fall through to an older
    // state dir that would inject a stale conversation.
    if (previousSession.length > 0 && previousSession === sessionId) return undefined
    const steps = stepRecords(state.steps)
    const users = stringArray(state.users, 6)
      ?? steps.map(step => step.user).filter((text): text is string => Boolean(text)).slice(-6)
    const tools = stringArray(state.tools, 6)
      ?? steps.flatMap(step => step.tools).slice(-6)
    const updated = state.updated_at ?? ''
    const md = typeof state.md_path === 'string' && state.md_path.length > 0
      ? state.md_path
      : join(dir, 'last-checkpoint.md')
    let handoffBlock = ''
    try {
      const handoff = JSON.parse(await readFile(join(dirname(md), 'auto-handoff.json'), 'utf8')) as AutoHandoffMeta
      const nextSteps = Array.isArray(handoff.next_steps)
        ? handoff.next_steps.filter((step): step is string => typeof step === 'string').slice(0, 5)
        : []
      const stepsText = nextSteps.length > 0
        ? nextSteps.map(step => `- ${step}`).join('\n')
        : '- （未提取到，见 handoff 文件）'
      handoffBlock = `\n上次自动 Handoff: ${typeof handoff.path === 'string' ? handoff.path : ''}\n下一步:\n${stepsText}\n`
    } catch {
      handoffBlock = ''
    }
    const bullets = (items: string[]): string =>
      items.length > 0 ? items.map(item => `- ${oneLine(item)}`).join('\n') : '- （无）'
    const message = `<上次会话自动续接>
上次会话: ${updated}（session ${previousSession.slice(0, 8)}）
最近在做:
${bullets(users)}
最近操作:
${bullets(tools)}
${handoffBlock}完整 checkpoint: ${md}
直接说「继续」即可从这里接着做；需要语义交接时运行 /dsh-resume。
</上次会话自动续接>`
    return message.slice(0, RESUME_MAX_CHARS)
  }
  return undefined
}
