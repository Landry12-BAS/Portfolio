// Unit tests for the schemas LB-01's board checks the API's answers with: the answers the real Django
// service gave, word for word, must pass, and an answer that does not fit must not.
import { describe, expect, it } from 'vitest'

import { ticketSchema } from '~/boards/lb-01/schemas'

// The answer to filing a ticket as the real Django API gave it (services/django-systems, run without a
// worker, on 2026-10-02): the pipeline had not started, so the ticket has no category and no run.
const FILED_ON_REAL_DJANGO = {
  id: 'qZeJdxFIisF3qdBJ',
  customer: { key: 'cus-0001', name: 'Sam Carter', language: 'en' },
  language: 'en',
  status: 'received',
  category: '',
  created_at: '2026-10-02T02:41:10.806Z',
  body: 'My order arrived with a torn bag and I would like a refund.',
  order_number: '',
  escalation_reason: '',
  run_id: '',
  expires_at: '2026-10-03T02:41:10.805Z',
  draft: null,
  decision: null,
}

describe('LB-01\'s ticket schema', () => {
  it('accepts a ticket the real API has just filed, which has no run yet', () => {
    expect(ticketSchema.safeParse(FILED_ON_REAL_DJANGO).success).toBe(true)
  })

  it('accepts a ticket with the ID of its run', () => {
    expect(ticketSchema.safeParse({ ...FILED_ON_REAL_DJANGO, run_id: 'run-3f9a1c7e2b' }).success).toBe(true)
  })

  it('refuses a run ID that is not one: too short, too long, or with characters a path should not carry', () => {
    for (const runId of ['short', 'r'.repeat(65), '../../etc/passwd', 'run 3f9a1c7e2b', 'run/3f9a1c7e2b']) {
      expect(ticketSchema.safeParse({ ...FILED_ON_REAL_DJANGO, run_id: runId }).success, runId).toBe(false)
    }
  })

  it('accepts the longest draft the drafter may write (sixteen sentences of 500 characters) and the decision that approves it', () => {
    const sentence = { text: 'x'.repeat(500), citations: ['passage:returns.withdrawal'], supported: true, problem: null }
    const draft = { sentences: Array.from({ length: 16 }, () => sentence), claims_supported: true, model: 'a-model', sources: [] }
    const decision = { action: 'approve', final_text: Array.from({ length: 16 }, () => 'x'.repeat(500)).join(' '), decided_at: '2026-10-02T03:00:00.000Z' }

    const parsed = ticketSchema.safeParse({ ...FILED_ON_REAL_DJANGO, status: 'sent', run_id: 'run-3f9a1c7e2b', draft, decision })

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('refuses a status the board would not know how to show', () => {
    expect(ticketSchema.safeParse({ ...FILED_ON_REAL_DJANGO, status: 'archived' }).success).toBe(false)
  })
})
