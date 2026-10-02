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

/** One line of the chat. */
export type ChatLine = VisitorLine | ConciergeLine | ActionLine

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

/** Tells how a tool call went, in the three ways the chat words it. */
export function toolOutcome(tool: ToolUse): 'ran' | 'refused' | 'failed' {
  if (!tool.executed) return 'refused'
  return tool.ok ? 'ran' : 'failed'
}
