// LB-01 as the mock back end plays it: a visitor files a ticket, the pipeline "runs" while the
// site polls it, a cited draft waits for a person, and the person approves, edits or escalates it.
// The answers have the shapes services/django-systems/openapi.json documents, and the outcomes
// follow the golden set's expectations for the curated samples, so the site's demo can be
// driven end to end without a model. Nothing here measures anything: the spans it makes are
// fixtures with made-up timings, and the drafts copy sentences of the real policies.
import { randomBytes } from 'node:crypto'

import type { CustomerSeed, GoldenCase, Language, PassageSeed, Seed } from './seed.ts'
import { mockSpans } from './spans.ts'
import type { MockSpan } from './spans.ts'

// A visitor may file this many tickets a day, as the real API allows.
export const TICKETS_PER_DAY = 20
// A ticket is kept this long, as the real one is.
const LIFETIME_MS = 24 * 60 * 60 * 1000

/**
 * When the API tells a visitor which run a ticket is. Django's pipeline gives a ticket its run ID
 * when the run starts but saves it with the outcome (services/django-systems/lb01/pipeline.py), so
 * the real API answers `run_id: ""` until the pipeline has finished, and a site cannot follow the
 * run's trace while it is going. `when-finished` plays that, and is the default because a test
 * double is only useful if it behaves like what it stands in for. `at-filing` plays the back end
 * the site is built to be ready for, which names the run in the answer to filing the ticket.
 */
export type RunIdDisclosure = 'when-finished' | 'at-filing'

/** What a test may choose about the mock's LB-01. */
export interface Lb01MockOptions {
  // How many times the site must ask for a ticket before the pipeline has finished with it: 2 by
  // default, one for "received" and one for "processing"; 0 makes a ticket ready as it is filed.
  pollsToFinish?: number
  // When the API names a ticket's run (`when-finished` by default).
  runId?: RunIdDisclosure
}

/** How the mock's pipeline ended a ticket. */
interface Outcome {
  route: 'awaiting_approval' | 'escalated'
  category: string
  order: string
  reason: string
  citations: string[]
}

/** One sentence of a draft, as the API reports it. */
interface Sentence {
  text: string
  citations: string[]
  supported: boolean
  problem: string | null
}

/** A decision a person made. */
interface Decision {
  action: string
  final_text: string
  decided_at: string
}

/** A ticket the mock holds for one visitor. */
interface Ticket {
  id: string
  session: string
  customer: CustomerSeed
  language: Language
  body: string
  createdAt: number
  runId: string
  // How many times the site has asked for it: the pipeline "advances" with each.
  polls: number
  outcome: Outcome
  decision: Decision | undefined
  spans: MockSpan[]
}

/** What the handlers return: a status, and a body that can be written as JSON when there is one. */
export interface Answer {
  status: number
  body?: unknown
}

/** Makes a platform error answer. */
export function errorAnswer(status: number, code: string, message: string): Answer {
  return { status, body: { error: { code, message } } }
}

/** Makes a random ID of lowercase letters and digits, as the real API's public IDs look. */
function newId(prefix: string, bytes: number): string {
  return `${prefix}${randomBytes(bytes).toString('hex')}`
}

/** Takes the first sentence of a passage's text. */
function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s|$)/s.exec(text)
  return (match?.[0] ?? text).replace(/\s+/g, ' ').trim()
}

/** The mock's LB-01: its customers, its tickets and their pipeline. */
export class Lb01Mock {
  readonly #seed: Seed
  readonly #now: () => number
  readonly #pollsToFinish: number
  readonly #runId: RunIdDisclosure
  readonly #tickets = new Map<string, Ticket>()

  /** Starts with no tickets. */
  constructor(seed: Seed, now: () => number, options: Lb01MockOptions = {}) {
    this.#seed = seed
    this.#now = now
    this.#pollsToFinish = options.pollsToFinish ?? 2
    this.#runId = options.runId ?? 'when-finished'
  }

  /** Forgets every ticket. */
  reset(): void {
    this.#tickets.clear()
  }

  /** Lists the synthetic customers. */
  customers(): Answer {
    return { status: 200, body: this.#seed.customers.map(customer => ({ key: customer.key, name: customer.name, language: customer.language })) }
  }

  /** Files a ticket for a visitor: 404 for an unknown customer, 429 past the day's twenty. */
  file(session: string, request: { customer: string, language: Language, body: string }): Answer {
    const customer = this.#seed.customers.find(candidate => candidate.key === request.customer)
    if (!customer) return errorAnswer(404, 'unknown_customer', 'There is no customer with that key.')
    if (this.#filedToday(session) >= TICKETS_PER_DAY) return errorAnswer(429, 'daily_limit', `A visitor may file ${TICKETS_PER_DAY} tickets a day.`)
    const runId = newId('run-', 10)
    const outcome = this.#decide(customer, request.body.trim())
    const ticket: Ticket = {
      id: newId('tk', 6),
      session,
      customer,
      language: request.language,
      body: request.body.trim(),
      createdAt: this.#now(),
      runId,
      polls: 0,
      outcome,
      decision: undefined,
      spans: [],
    }
    ticket.spans = mockSpans(ticket.runId, ticket.createdAt, outcome.route === 'escalated' ? outcome.reason : undefined, outcome.citations.length)
    this.#tickets.set(ticket.id, ticket)
    return { status: 202, body: this.#out(ticket, 'received') }
  }

  /** Lists a visitor's tickets, newest first. */
  list(session: string): Answer {
    const own = this.#own(session)
    return { status: 200, body: own.map(ticket => this.#summary(ticket, this.#status(ticket))) }
  }

  /** Reads one of the visitor's tickets, and lets its pipeline move on a step. */
  get(session: string, id: string): Answer {
    const ticket = this.#find(session, id)
    if (!ticket) return errorAnswer(404, 'not_found', 'There is no such ticket.')
    ticket.polls += 1
    return { status: 200, body: this.#out(ticket, this.#status(ticket)) }
  }

  /** Approves, edits or escalates a draft that waits for a person, once. */
  decide(session: string, id: string, request: { action: string, text?: string | null }): Answer {
    const ticket = this.#find(session, id)
    if (!ticket) return errorAnswer(404, 'not_found', 'There is no such ticket.')
    if (this.#status(ticket) !== 'awaiting_approval' || ticket.decision) return errorAnswer(409, 'not_waiting', 'Only a draft waiting for approval can be decided.')
    const finalText = request.action === 'approve' ? this.#sentences(ticket).map(sentence => sentence.text).join(' ') : request.action === 'edit' ? (request.text ?? '') : ''
    ticket.decision = { action: request.action, final_text: finalText, decided_at: new Date(this.#now()).toISOString() }
    return { status: 200, body: this.#out(ticket, this.#status(ticket)) }
  }

  /** Counts a visitor's tickets and decisions, as the demo's counters need them. */
  stats(session: string): Answer {
    const own = this.#own(session)
    const decided = own.filter(ticket => ticket.decision)
    const approved = decided.filter(ticket => ticket.decision?.action === 'approve').length
    const edited = decided.filter(ticket => ticket.decision?.action === 'edit').length
    const escalatedByPerson = decided.filter(ticket => ticket.decision?.action === 'escalate').length
    const sent = approved + edited
    const total = sent + escalatedByPerson
    return {
      status: 200,
      body: {
        tickets: own.length,
        awaiting_approval: own.filter(ticket => this.#status(ticket) === 'awaiting_approval').length,
        sent,
        sent_unedited: approved,
        escalated: own.filter(ticket => this.#status(ticket) === 'escalated').length,
        deflection: total > 0 ? sent / total : null,
        accuracy: sent > 0 ? approved / sent : null,
      },
    }
  }

  /** Returns the spans the pipeline has written for a run so far, oldest first, or undefined for an unknown run. */
  spansOf(runId: string): MockSpan[] | undefined {
    const ticket = [...this.#tickets.values()].find(candidate => candidate.runId === runId)
    if (!ticket) return undefined
    const status = this.#status(ticket)
    if (status === 'received') return undefined
    if (status === 'processing') return ticket.spans.filter(span => span.endMs - ticket.createdAt < 1_200 && span.kind !== 'system.run')
    return ticket.spans
  }

  /** Gives a ticket the spans it should have, for a test that wants a particular trace. */
  setSpans(id: string, spans: MockSpan[]): void {
    const ticket = this.#tickets.get(id)
    if (ticket) ticket.spans = spans
  }

  /** Lists the visitor's tickets, newest first. */
  #own(session: string): Ticket[] {
    return [...this.#tickets.values()].filter(ticket => ticket.session === session).reverse()
  }

  /** Finds one of the visitor's tickets: another visitor's is exactly as missing as one that isn't there. */
  #find(session: string, id: string): Ticket | undefined {
    const ticket = this.#tickets.get(id)
    return ticket?.session === session ? ticket : undefined
  }

  /** Counts the tickets the visitor filed since midnight, UTC. */
  #filedToday(session: string): number {
    const midnight = new Date(this.#now()).setUTCHours(0, 0, 0, 0)
    return this.#own(session).filter(ticket => ticket.createdAt >= midnight).length
  }

  /** Says how far the pipeline has got with a ticket: it moves on as the site asks for it. */
  #status(ticket: Ticket): string {
    if (ticket.polls < this.#pollsToFinish - 1) return 'received'
    if (ticket.polls < this.#pollsToFinish) return 'processing'
    if (ticket.decision) return ticket.decision.action === 'escalate' ? 'escalated' : 'sent'
    return ticket.outcome.route
  }

  /** Decides how the pipeline ends a ticket: as the golden set says for a sample, else by what the text says. */
  #decide(customer: CustomerSeed, body: string): Outcome {
    const known: GoldenCase | undefined = this.#seed.golden.find(candidate => candidate.ticket === body)
    if (known) {
      const category = Array.isArray(known.expect.category) ? (known.expect.category[0] ?? 'other') : (known.expect.category ?? 'other')
      return { route: known.expect.route, category, order: known.expect.order ?? '', reason: known.expect.reason ?? '', citations: known.expect.cites ?? [] }
    }
    if (/ignore (?:all )?(?:your |the )?previous instructions/i.test(body)) return { route: 'escalated', category: 'other', order: '', reason: 'injection', citations: [] }
    if (/lawyer|solicitor|allerg|fraud/i.test(body)) return { route: 'escalated', category: 'other', order: '', reason: 'senior_agent', citations: [] }
    const order = /BB-\d{4}/.exec(body)?.[0] ?? ''
    const owned = this.#seed.orders.get(order)?.customer === customer.key
    return { route: 'awaiting_approval', category: 'other', order: owned ? order : '', reason: '', citations: ['shipping.delivery-times'] }
  }

  /** Writes the draft as sentences: one for each cited passage, one for the order, and an unsupported promise when the ticket asks for a refund. */
  #sentences(ticket: Ticket): Sentence[] {
    const sentences: Sentence[] = ticket.outcome.citations.flatMap((key) => {
      const passage = this.#seed.passages.get(key)
      return passage ? [{ text: firstSentence(passage.text[ticket.language]), citations: [`passage:${key}`], supported: true, problem: null }] : []
    })
    if (ticket.outcome.order) {
      const text = ticket.language === 'cs' ? `Vaši objednávku ${ticket.outcome.order} jsme našli.` : `We found your order ${ticket.outcome.order}.`
      sentences.unshift({ text, citations: [`order:${ticket.outcome.order}`], supported: true, problem: null })
    }
    if (/refund|vrácen|vrátit/i.test(ticket.body)) {
      const text = ticket.language === 'cs' ? 'Peníze vám vrátíme ještě dnes.' : 'We will refund you today.'
      sentences.push({ text, citations: [], supported: false, problem: 'No source says a refund is promised.' })
    }
    return sentences
  }

  /** Describes the sources a draft cites, in the ticket's language. */
  #sources(ticket: Ticket): Record<string, unknown>[] {
    const sources: Record<string, unknown>[] = ticket.outcome.citations.flatMap((key) => {
      const passage: PassageSeed | undefined = this.#seed.passages.get(key)
      if (!passage) return []
      const language = ticket.language
      return [{ id: `passage:${key}`, title: `${passage.policyTitle[language]} §${passage.position}: ${passage.title[language]}`, text: passage.text[language] }]
    })
    const order = this.#seed.orders.get(ticket.outcome.order)
    if (order && ticket.outcome.order) {
      const items = order.items.map(item => `${item.quantity} x ${item.product} ${item.grams} g`).join(', ')
      sources.unshift({ id: `order:${order.number}`, title: `Order ${order.number}`, text: `Order ${order.number}: ${order.status}, shipped by ${order.carrier} (${order.trackingNumber}); ${items}; total ${order.totalCzk} CZK.` })
    }
    return sources
  }

  /** Describes a ticket for the queue. */
  #summary(ticket: Ticket, status: string): Record<string, unknown> {
    return {
      id: ticket.id,
      customer: { key: ticket.customer.key, name: ticket.customer.name, language: ticket.customer.language },
      language: ticket.language,
      status,
      category: status === 'received' || status === 'processing' ? '' : ticket.outcome.category,
      created_at: new Date(ticket.createdAt).toISOString(),
    }
  }

  /** Describes a ticket in full, with its draft and decision once the pipeline has finished. */
  #out(ticket: Ticket, status: string): Record<string, unknown> {
    const finished = status !== 'received' && status !== 'processing'
    const hasDraft = finished && ticket.outcome.route === 'awaiting_approval'
    const sentences = hasDraft ? this.#sentences(ticket) : []
    return {
      ...this.#summary(ticket, status),
      body: ticket.body,
      order_number: finished ? ticket.outcome.order : '',
      escalation_reason: finished ? ticket.outcome.reason : '',
      run_id: finished || this.#runId === 'at-filing' ? ticket.runId : '',
      expires_at: new Date(ticket.createdAt + LIFETIME_MS).toISOString(),
      draft: hasDraft ? { sentences, claims_supported: sentences.every(sentence => sentence.supported), model: 'mock/draft-model', sources: this.#sources(ticket) } : null,
      decision: ticket.decision ?? null,
    }
  }
}
