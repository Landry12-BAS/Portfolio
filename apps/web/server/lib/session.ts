// The visitor's anonymous session, exactly as docs/SECURITY.md, section 2, describes it: a random
// 128-bit ID in a signed cookie with the `__Host-` prefix, `HttpOnly`, `Secure` and
// `SameSite=Strict`, rotated daily. It exists only for quotas and abuse protection, so it holds
// nothing about the visitor: the ID, the day it was made for, and whether Turnstile has passed.
//
// The back ends never see the ID. They know a visitor by a keyed hash of it (the `sub` of the
// visitor token), made with a key derived from the session secret that the cookie's own
// signature doesn't share, so a hash tells nobody the ID and a cookie can't be made from a hash.
// The ID rotates at midnight UTC, the moment the daily quotas turn over, so rotating never gives
// a visitor a second day's allowance in one day.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

import { getCookie, setCookie } from 'h3'
import type { H3Event } from 'h3'

/** The cookie's name. The `__Host-` prefix makes a browser accept it only from this exact host, over HTTPS, for the whole site, and never from a sibling subdomain. */
export const SESSION_COOKIE = '__Host-lb_session'

// The cookie's value is `v1.<payload>.<signature>`, with the payload as base64url JSON.
const COOKIE_FORMAT = /^v1\.([\w-]{20,200})\.([\w-]{43})$/
// A session ID is 16 random bytes in base64url: 22 characters.
const SESSION_ID = /^[\w-]{22}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const SECONDS_PER_DAY = 86_400

/** One visitor's session for one day. */
export interface Session {
  // The random ID. It never leaves the server: the back ends see only its hash.
  id: string
  // The day, UTC, this session was made for (YYYY-MM-DD). A cookie from another day is not a session.
  day: string
  // Whether the visitor has passed the Turnstile check on this session.
  verified: boolean
}

/** What the sessions are made from: the secret, the clock and the source of random bytes. */
export interface SessionSettings {
  secret: Buffer
  now: () => number
  random: (bytes: number) => Buffer
}

/** Derives a 32-byte key for one purpose from the session secret, so no key is used for two jobs. */
function deriveKey(secret: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `lb-web ${purpose}`, 32))
}

/** Makes and checks the visitors' sessions. */
export class Sessions {
  readonly #cookieKey: Buffer
  readonly #subjectKey: Buffer
  readonly #now: () => number
  readonly #random: (bytes: number) => Buffer

  /** Derives the keys it needs from the session secret. */
  constructor(settings: SessionSettings) {
    this.#cookieKey = deriveKey(settings.secret, 'session cookie signature')
    this.#subjectKey = deriveKey(settings.secret, 'visitor subject')
    this.#now = settings.now
    this.#random = settings.random
  }

  /** Returns today's date in UTC, as YYYY-MM-DD. */
  today(): string {
    return new Date(this.#now()).toISOString().slice(0, 10)
  }

  /** Returns the next midnight UTC, when the day's quotas start again and today's sessions end. */
  resetsAt(): Date {
    const midnight = new Date(this.#now())
    midnight.setUTCHours(24, 0, 0, 0)
    return midnight
  }

  /** Signs a payload. */
  #sign(payload: string): string {
    return createHmac('sha256', this.#cookieKey).update(`v1.${payload}`).digest('base64url')
  }

  /** Reads the visitor's session from the request's cookie, or returns undefined: no cookie, a damaged or forged one, or one from another day. */
  read(event: H3Event): Session | undefined {
    const match = COOKIE_FORMAT.exec(getCookie(event, SESSION_COOKIE) ?? '')
    const payload = match?.[1]
    const signature = match?.[2]
    if (payload === undefined || signature === undefined) return undefined
    const expected = Buffer.from(this.#sign(payload))
    const given = Buffer.from(signature)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined
    let value: unknown
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    }
    catch {
      return undefined
    }
    const { i, d, v } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
    if (typeof i !== 'string' || !SESSION_ID.test(i) || typeof d !== 'string' || !DAY.test(d) || d !== this.today()) return undefined
    return { id: i, day: d, verified: v === 1 }
  }

  /** Writes the session to the response as a cookie that lasts until the day's end. */
  write(event: H3Event, session: Session): void {
    const payload = Buffer.from(JSON.stringify({ i: session.id, d: session.day, v: session.verified ? 1 : 0 })).toString('base64url')
    const secondsLeft = Math.max(Math.ceil((this.resetsAt().getTime() - this.#now()) / 1_000), 1)
    setCookie(event, SESSION_COOKIE, `v1.${payload}.${this.#sign(payload)}`, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: Math.min(secondsLeft, SECONDS_PER_DAY),
    })
  }

  /**
   * Returns the visitor's session, starting one (and setting its cookie) when there is none.
   * A session ID is only ever made here, from random bytes, and never taken from a request:
   * a cookie that isn't ours, and signed by us, is not a session, so an attacker can't plant one.
   */
  ensure(event: H3Event): Session {
    const existing = this.read(event)
    if (existing) return existing
    const session: Session = { id: this.#random(16).toString('base64url'), day: this.today(), verified: false }
    this.write(event, session)
    return session
  }

  /** Marks a session as having passed Turnstile, and writes it back. */
  markVerified(event: H3Event, session: Session): Session {
    const verified: Session = { ...session, verified: true }
    this.write(event, verified)
    return verified
  }

  /** Returns the keyed hash that stands for the session in a visitor token: 43 characters of base64url, never the ID. */
  subjectOf(session: Session): string {
    return createHmac('sha256', this.#subjectKey).update(session.id).digest('base64url')
  }
}
