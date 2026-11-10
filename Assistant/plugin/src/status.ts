/**
 * UI data source: writes the mem0 bridge status as a JSON file inside the
 * session workspace (`<cwd>/notes/_state/mem0-status.json`) so the browser-side
 * client plugin can read it through the Workspace Files service (the only file
 * channel the web client can access). Written on session start and on every
 * turn boundary — the file's change stream drives the panel refresh.
 * @module status
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { basePayload, captureHookStdout, type BridgeConfig } from './capture.ts'

/**
 * Write a small heartbeat file as soon as the bridge plugin is activated and on
 * every session/turn boundary. The UI reads the workspace status file; this
 * heartbeat answers a different question for `doctor-dsh.ps1`: is the host
 * plugin loaded at all? A stale/missing heartbeat means the bridge did not
 * activate (build/import failure), while a fresh heartbeat with no buffers
 * means it loaded but the session has not produced events yet.
 */
export async function writeBridgeHeartbeat(config: BridgeConfig): Promise<void> {
  try {
    await mkdir(config.dataDir, { recursive: true })
    const payload = {
      at: new Date().toISOString(),
      pid: process.pid,
      node: process.version,
      cwd: process.cwd(),
      dataDir: config.dataDir,
      hooksScript: config.hooksScript,
    }
    await writeFile(join(config.dataDir, 'bridge-alive.json'), JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    // Diagnostics only; never affect the session.
  }
}

/** Bridge-computed extras folded into the status file beside the ui-status payload. */
export interface UiStatusExtra {
  /** Total tokens recorded by the checkpoint ring buffer this session. */
  tokens?: number
  /** Tokens currently occupying the session context (tokenMeter). */
  contextTokens?: number
  /** Context-guard level for the session, or null below warn. */
  guardLevel?: string | null
  /** Where the last checkpoint was written, when one was. */
  checkpointPath?: string | null
  /** True when written from agent/disposed: the session is over. */
  ended?: boolean
}

/**
 * Pending event count of one session from a ui-status payload.
 * Buffers are keyed by the wrapper's truncated session id (first 16 chars),
 * so match by prefix.
 */
export function sessionPendingOf(
  status: { pending_buffers?: Array<{ session: string; pending: number }> },
  sessionId: string,
): number {
  const buffers = status.pending_buffers ?? []
  const hit = buffers.find(b => b.session === sessionId.slice(0, 16) || sessionId.startsWith(b.session))
  return hit?.pending ?? 0
}

/**
 * Run the wrapper's `ui-status` subcommand and write the merged status JSON.
 * Prefers `<cwd>/notes/_state/` (workspace-readable by the browser), falls
 * back to `~/.dsh/state/mem0/` when the project dir is not writable. Never
 * throws — a status write failure must not affect the session.
 */
export async function writeStatusFile(
  cwd: string | undefined,
  sessionId: string,
  config: BridgeConfig,
  log: (msg: string) => void,
  extra: UiStatusExtra = {},
): Promise<void> {
  try {
    const raw = await captureHookStdout(config, 'ui-status', basePayload(sessionId, cwd, 'UIStatus'), log)
    if (!raw) return
    let status: Record<string, unknown>
    try {
      status = JSON.parse(raw) as Record<string, unknown>
    } catch {
      log('mem0-dsh-bridge: ui-status printed non-JSON output; skipping status file')
      return
    }
    const payload = {
      ...status,
      sessionPending: sessionPendingOf(status as { pending_buffers?: Array<{ session: string; pending: number }> }, sessionId),
      sessionId,
      updatedAt: new Date().toISOString(),
      ...extra,
    }
    const json = JSON.stringify(payload, null, 2)
    const candidates: string[] = cwd !== undefined
      ? [resolve(cwd, 'notes', '_state'), join(homedir(), '.dsh', 'state', 'mem0')]
      : [join(homedir(), '.dsh', 'state', 'mem0')]
    for (const dir of candidates) {
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'mem0-status.json'), json, 'utf8')
        return
      } catch {
        // try next candidate
      }
    }
    log('mem0-dsh-bridge: no writable location for mem0-status.json')
  } catch (error) {
    log(`mem0-dsh-bridge: status write failed: ${String(error)}`)
  }
}
