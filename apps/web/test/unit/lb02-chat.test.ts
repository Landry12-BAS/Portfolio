// Tests of how LB-02's chat is made from what the server says: the lines of a transcript, how a tool
// call went, and what a picked-up conversation's transcript says about the visitor's last message.
import { describe, expect, it } from 'vitest'

import { LineNumbers, lastMessage, linesFromTranscript, toolOutcome } from '~/boards/lb-02/chat'
import type { ChatLine } from '~/boards/lb-02/chat'
import type { Line } from '~/boards/lb-02/wire'

/** Makes the lines of a chat from short descriptions, `v:` for the visitor, `c:` for the concierge, `a:` for a note of an action. */
function chat(...parts: string[]): ChatLine[] {
  const roles = { v: 'visitor', c: 'concierge', a: 'action' } as const
  const transcript: Line[] = parts.map((part) => {
    const [mark = '', ...rest] = part.split(':')
    return { role: roles[mark as keyof typeof roles], text: rest.join(':') }
  })
  return linesFromTranscript(transcript, new LineNumbers())
}

describe('LB-02\'s chat lines', () => {
  it('makes a line for each line of the transcript, in order, each with a number of its own', () => {
    const lines = chat('v:Hello', 'a:Recorded name.', 'c:Welcome')
    expect(lines.map(line => line.kind)).toEqual(['visitor', 'action', 'concierge'])
    expect(new Set(lines.map(line => line.id)).size).toBe(3)
    expect(lines[2]).toMatchObject({ kind: 'concierge', text: 'Welcome', receipt: null, tools: [] })
  })

  it('tells how a tool call went', () => {
    expect(toolOutcome({ name: 'hold_slot', executed: true, ok: true, error: '' })).toBe('ran')
    expect(toolOutcome({ name: 'hold_slot', executed: true, ok: false, error: 'slot_taken' })).toBe('failed')
    expect(toolOutcome({ name: 'confirm_booking', executed: false, ok: false, error: 'not_allowed' })).toBe('refused')
  })
})

describe('LB-02\'s check of the visitor\'s last message after a drop', () => {
  it('finds nothing to say when the concierge answered it', () => {
    expect(lastMessage(chat('v:Hello'), chat('v:Hello', 'c:Hi'))).toEqual({ state: 'answered' })
  })

  it('finds nothing to say for a conversation nobody has spoken in yet', () => {
    expect(lastMessage([], [])).toEqual({ state: 'answered' })
  })

  it('says it has no answer when the server kept the message and nothing from the concierge follows it', () => {
    expect(lastMessage(chat('v:Hello'), chat('v:Hello'))).toEqual({ state: 'unanswered' })
    expect(lastMessage([], chat('v:One', 'c:Two', 'v:Three'))).toEqual({ state: 'unanswered' })
  })

  it('does not take a note of an action for an answer', () => {
    expect(lastMessage(chat('v:Hello'), chat('v:Hello', 'a:Recorded name.'))).toEqual({ state: 'unanswered' })
  })

  it('looks at the last message only: an earlier one that was answered is no reason to say anything', () => {
    expect(lastMessage(chat('v:One', 'c:Two', 'v:Three'), chat('v:One', 'c:Two', 'v:Three', 'c:Four'))).toEqual({ state: 'answered' })
  })

  it('returns the words of a message the page showed and the server never got', () => {
    expect(lastMessage(chat('v:One', 'c:Two', 'v:Three'), chat('v:One', 'c:Two'))).toEqual({ state: 'lost', text: 'Three' })
    expect(lastMessage(chat('v:Hello'), [])).toEqual({ state: 'lost', text: 'Hello' })
  })
})
