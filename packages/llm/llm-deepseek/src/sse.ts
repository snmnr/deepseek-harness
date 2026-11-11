/** SSE framing delegated to eventsource-parser; JSON errors remain provider failures. */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { object } from './replay.ts'
import { providerError } from './transport.ts'

/** Decode complete SSE frames without treating an unterminated tail as an event.
 * @param body - provider response bytes.
 * @param activity - pulse the idle watchdog for events and heartbeat comments.
 * @returns JSON events, including message_stop; the translator owns completion.
 */
export async function* parseSse(body: ReadableStream<BufferSource>, activity: () => void): AsyncGenerator<Record<string, unknown>> {
  const events = body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment: activity }))
  for await (const frame of events) {
    activity()
    const text = frame.data
    let raw: unknown
    try { raw = JSON.parse(text) } catch (_invalidSseJson) {
      const snippet = text.replace(/\s+/gu, ' ').trim().slice(0, 160)
      // Gateways often answer a streaming request with an HTML 502/504 page.
      // Report that as an upstream failure (retryable) instead of blaming the
      // provider protocol; keep the snippet so the operator can recognize it.
      if (/^</u.test(text.trim())) {
        throw new LlmError(`DeepSeek Messages SSE received an HTML error page (upstream gateway 502/504?): ${snippet}`, 'SERVER')
      }
      throw new LlmError(`DeepSeek Messages SSE contains invalid JSON: ${snippet}`, 'MALFORMED_RESPONSE')
    }
    const event = object(raw)
    if (typeof event.type !== 'string' || (frame.event !== undefined && frame.event !== event.type)) {
      throw new LlmError('DeepSeek Messages SSE event type mismatch', 'MALFORMED_RESPONSE')
    }
    if (event.type === 'error') throw providerError(event, undefined)
    yield event
  }
}
