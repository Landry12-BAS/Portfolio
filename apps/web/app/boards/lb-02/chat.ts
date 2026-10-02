// The lines of the chat the board shows, and how they are made from what the server says: a
// resumed conversation's transcript, and the visitor's and the concierge's messages as a turn goes.
// A line is plain data; the component that draws the chat has no logic of its own to get wrong.
import type { Line, Receipt, ToolUse } from './wire.ts'

/** A message the visitor sent. */
export interface VisitorLine {
  id: number
  kind: 'visitor'
  text: string
}

/** A message from the concierge: its words, the kind of message the booking code wrote itself when it was one, and the tools called to make it. */
export interface ConciergeLine {
  id: number
  kind: 'concierge'
  text: string
  receipt: Receipt | null
  tools: readonly ToolUse[]
}

/** A note of something the concierge did, such as holding a slot. The server writes these in English. */
export interface ActionLine {
  id: number
  kind: 'action'
  text: string
}

/** A pause between two messages, such as the minutes a recorded conversation waited for another visitor's hold to run out. */
export interface PauseLine {
  id: number
  kind: 'pause'
  minutes: number
}

/** One line of the chat. */
export type ChatLine = VisitorLine | ConciergeLine | ActionLine | PauseLine

/** Hands out the lines' IDs, which only keep the list's items apart as it changes. */
export class LineNumbers {
  #last = 0

  /** Returns the next number. */
  next(): number {
    this.#last += 1
    return this.#last
  }
}

/** Makes the chat out of a conversation's transcript, oldest first. */
export function linesFromTranscript(transcript: readonly Line[], numbers: LineNumbers): ChatLine[] {
  return transcript.map((line): ChatLine => {
    const id = numbers.next()
    if (line.role === 'visitor') return { id, kind: 'visitor', text: line.text }
    if (line.role === 'concierge') return { id, kind: 'concierge', text: line.text, receipt: null, tools: [] }
    return { id, kind: 'action', text: line.text }
  })
}

/** How the visitor's last message stands once a conversation is picked up again: answered, kept by the server without an answer, or never kept. */
export type LastMessage
  = | { state: 'answered' }
    | { state: 'unanswered' }
    | { state: 'lost', text: string }

/** Picks the visitor's own messages out of the lines. */
function visitorLines(lines: readonly ChatLine[]): VisitorLine[] {
  return lines.filter((line): line is VisitorLine => line.kind === 'visitor')
}

/** Tells whether the concierge has said anything since the visitor's last message. Notes of actions and pauses are not answers. */
function answersTheLastMessage(lines: readonly ChatLine[]): boolean {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const kind = lines[index]?.kind
    if (kind === 'concierge') return true
    if (kind === 'visitor') return false
  }
  return true
}

/**
 * Compares what the page showed before a drop with the transcript the server sent when the conversation was picked
 * up again. The server's transcript is the record. If the page showed more of the visitor's messages than the
 * server kept, the last one never arrived, and its words are returned so they can go back in the box. If the server
 * kept it but nothing answers it, the answer was lost with the connection.
 */
export function lastMessage(before: readonly ChatLine[], after: readonly ChatLine[]): LastMessage {
  const shown = visitorLines(before)
  const kept = visitorLines(after)
  const last = shown.at(-1)
  if (last !== undefined && shown.length > kept.length) return { state: 'lost', text: last.text }
  return answersTheLastMessage(after) ? { state: 'answered' } : { state: 'unanswered' }
}

/** Tells how a tool call went, in the three ways the chat words it. */
export function toolOutcome(tool: ToolUse): 'ran' | 'refused' | 'failed' {
  if (!tool.executed) return 'refused'
  return tool.ok ? 'ran' : 'failed'
}
