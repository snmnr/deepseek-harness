/**
 * Event→subcommand translation: spawns `python mem0_hooks_dsh.py <sub>` with a
 * Claude-Code-shaped JSON payload on stdin. The Python side owns the entire
 * buffering/redaction/flush contract; this module only translates dsh events
 * into subcommand invocations and never touches buffer files itself.
 * @module capture
 */

import { spawn } from 'node:child_process'

/** Plugin config shared by all modules. */
export interface BridgeConfig {
  /** Python executable used to spawn hook subcommands. */
  python: string
  /** Absolute path to the mem0_hooks_dsh.py wrapper script. */
  hooksScript: string
  /** Data directory handed to the wrapper via MEM0_DATA_DIR. */
  dataDir: string
  /** mem0 connection overrides passed through as env (optional). */
  apiUrl?: string
  /** API key override (normally resolved via ${credential:...} in the patch). */
  apiKey?: string
  /** Default user id override (optional). */
  userId?: string
  /** Subcommand timeout in ms (default 30000). */
  timeoutMs?: number
}

export const DEFAULT_TIMEOUT_MS = 30_000

/** Build the env every hook subprocess runs under (mirrors the CC hook contract). */
export function hookEnv(config: BridgeConfig): Record<string, string> {
  const env: Record<string, string> = { MEM0_DATA_DIR: config.dataDir }
  if (config.apiUrl) env.MEM0_API_URL = config.apiUrl
  if (config.apiKey) env.MEM0_API_KEY = config.apiKey
  if (config.userId) env.MEM0_DEFAULT_USER_ID = config.userId
  return env
}

/**
 * Run one hook subcommand to completion. Never throws: failures are logged via
 * `log` and swallowed — a hook error must never block the session (same
 * containment contract as the Python side).
 */
export function runHookCommand(
  config: BridgeConfig,
  subcommand: string,
  payload: Record<string, unknown>,
  log: (msg: string) => void,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(config.python, [config.hooksScript, subcommand], {
      env: { ...process.env, ...hookEnv(config) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill()
        log(`mem0-dsh-bridge: ${subcommand} timed out after ${timeoutMs}ms`)
      }
    }, timeoutMs)
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    }
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (error) => {
      log(`mem0-dsh-bridge: ${subcommand} spawn failed: ${String(error)}`)
      finish(null)
    })
    child.on('close', (code) => finish(code))
    try {
      child.stdin.end(JSON.stringify(payload))
    } catch (error) {
      log(`mem0-dsh-bridge: ${subcommand} stdin write failed: ${String(error)}`)
    }
  })
}

/**
 * Fire-and-forget spawn for emit-shaped event points. Detached-ish: errors are
 * logged, the promise never rejects, and the caller does not await it.
 */
export function fireHookCommand(
  config: BridgeConfig,
  subcommand: string,
  payload: Record<string, unknown>,
  log: (msg: string) => void,
): void {
  void runHookCommand(config, subcommand, payload, log)
}

/**
 * Await one hook subcommand and return its trimmed stdout, or undefined when
 * nothing was printed (used for the recall path, whose stdout carries the
 * `<mem0 相关历史记忆>` block).
 */
export async function captureHookStdout(
  config: BridgeConfig,
  subcommand: string,
  payload: Record<string, unknown>,
  log: (msg: string) => void,
): Promise<string | undefined> {
  const { stdout, stderr, code } = await runHookCommand(config, subcommand, payload, log)
  if (code !== 0 && stderr) log(`mem0-dsh-bridge: ${subcommand} stderr: ${stderr.trim()}`)
  const text = stdout.trim()
  return text.length > 0 ? text : undefined
}

/** Session payload base shared by every subcommand (mirrors the CC hook base). */
export function basePayload(sessionId: string, cwd: string | undefined, event: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    cwd,
    hook_event_name: event,
    // dsh has no transcript file for hooks; the wrapper ignores the field.
    transcript_path: '',
  }
}
