/**
 * Distillation feed exporter: on agent disposal, writes the captured user /
 * assistant text and tool summaries as a Claude-Code-transcript-compatible
 * JSONL file, so mem0-claude-kit's distill-history.mjs (copied to
 * Assistant/tools/ with only a --projects override) reads dsh sessions with
 * zero changes to its cleaning / dedup / ledger logic.
 * @module export
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** One captured message in the export buffer. */
export interface ExportMessage {
  role: 'user' | 'assistant'
  ts: string
  text: string
}

const MAX_TEXT_CHARS = 8000
const MAX_TOOL_LINE_CHARS = 200
/** Cap per file so a runaway session cannot write unbounded JSONL. */
const MAX_MESSAGES = 4000

/**
 * In-memory export buffer for one session. Kept alongside the checkpoint
 * state; both consume the same `session/event` stream.
 */
export class ExportBuffer {
  readonly messages: ExportMessage[] = []
  readonly tools: string[] = []
  private startedAt: string | undefined
  private cwd: string

  constructor(cwd: string | undefined) {
    this.cwd = cwd ?? process.cwd()
  }

  get directory(): string {
    return this.cwd
  }

  addUser(text: string, time: number): void {
    if (this.messages.length >= MAX_MESSAGES) return
    if (!this.startedAt) this.startedAt = new Date(time).toISOString()
    this.push({ role: 'user', ts: new Date(time).toISOString(), text: truncate(text) })
  }

  addAssistant(text: string, time: number): void {
    if (this.messages.length >= MAX_MESSAGES) return
    this.push({ role: 'assistant', ts: new Date(time).toISOString(), text: truncate(text) })
  }

  addTool(name: string, argsPreview: string): void {
    if (this.tools.length >= 200) return
    const line = `${name}: ${argsPreview}`
    this.tools.push(line.length > MAX_TOOL_LINE_CHARS ? line.slice(0, MAX_TOOL_LINE_CHARS) + '…' : line)
  }

  private push(m: ExportMessage): void {
    const prev = this.messages.at(-1)
    if (prev && prev.role === m.role && prev.text === m.text) return
    this.messages.push(m)
  }

  get isEmpty(): boolean {
    return this.messages.length === 0
  }
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + '\n…[已截断]' : text
}

/** CC-transcript-shaped line: `{"type":"user","message":{"content":[...]}}`. */
function transcriptLine(m: ExportMessage): string {
  return JSON.stringify({
    type: m.role,
    timestamp: m.ts,
    message: { role: m.role, content: [{ type: 'text', text: m.text }] },
  })
}

function slug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'default'
}

/**
 * Write the export JSONL and append the distill-pending entry.
 *
 * File I/O is synchronous on purpose: `agent/disposed` is an emit event, so
 * nothing awaits this call during process shutdown — an async write can be
 * cut off after the JSONL lands but before the pending queue's rename (seen
 * as a stray `pending.json.tmp-<pid>`). Sync I/O finishes before the handler
 * returns.
 * @returns the export file path, or undefined when there was nothing to write.
 */
export async function writeExport(
  sessionId: string,
  buffer: ExportBuffer,
  opts: { exportsDir?: string; pendingPath?: string } = {},
): Promise<string | undefined> {
  if (buffer.isEmpty) return undefined
  const exportsRoot = opts.exportsDir ?? join(homedir(), '.mem0-claude-dsh', 'exports')
  const pendingPath = opts.pendingPath ?? join(homedir(), '.affine-docs', 'distill', 'pending.json')
  const dir = join(exportsRoot, slug(buffer.directory))
  const file = join(dir, `${sessionId}.jsonl`)

  const lines = [...buffer.messages.map(transcriptLine)]
  // Tool activity as a trailing synthetic user line so distill sees it but the
  // assistant narrative stays clean.
  if (buffer.tools.length > 0) {
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: `[本会话工具活动摘要]\n${buffer.tools.join('\n')}` }] },
    }))
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')

  try {
    mkdirSync(join(pendingPath, '..'), { recursive: true })
    let queue: { version?: number; items?: Array<Record<string, unknown>> } = {}
    try {
      queue = JSON.parse(readFileSync(pendingPath, 'utf8')) as typeof queue
    } catch {
      // missing or malformed queue: start a fresh one
    }
    queue.version = 1
    queue.items = queue.items ?? []
    if (!queue.items.some(i => i.sessionId === sessionId)) {
      queue.items.push({
        sessionId,
        transcriptPath: file,
        project: slug(buffer.directory),
        source: 'dsh',
        endedAt: new Date().toISOString(),
      })
    }
    const tmp = `${pendingPath}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(queue, null, 2), 'utf8')
    renameSync(tmp, pendingPath)
  } catch {
    // pending queue is best-effort; the export file itself is the durable artifact
  }
  return file
}
