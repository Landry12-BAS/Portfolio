// Reads server-sent events (SSE) from a provider's streamed answer.
import { EventSourceParserStream } from 'eventsource-parser/stream'

// A provider that never ends a line or an event could otherwise grow the parser's
// buffer without bound; past this size the stream errors instead.
const MAX_EVENT_BYTES = 1_048_576

/**
 * Yields the `data` payload of each server-sent event in a response body, in order.
 * Comment lines (keep-alives such as `: OPENROUTER PROCESSING`) are skipped.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const events = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ maxBufferSize: MAX_EVENT_BYTES, onError: 'terminate' }))
  for await (const event of events) yield event.data
}
