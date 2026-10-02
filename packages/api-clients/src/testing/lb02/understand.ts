// What the mock concierge makes of a visitor's message. The real concierge asks a model; the mock
// reads the message with plain rules that are enough for the curated conversations of the golden set
// and for the things a visitor is likely to try: which offering, how many guests, a name, an email
// address, a day, a part of the day, a time, a yes or a no, a number, a request for a person, an
// attempt to take over the concierge. It is a test double: it does not pretend to understand
// language, and a message it cannot read is answered by asking again.

/** The parts of the day a visitor may ask for. */
export type PartOfDay = 'morning' | 'afternoon' | 'evening'

/** What a message says. A field is absent when the message does not say it. */
export interface Understood {
  // The language the message looks written in, when it can tell.
  language: 'en' | 'cs' | undefined
  injection: boolean
  wantsPerson: boolean
  outOfScope: boolean
  offering: string | undefined
  partySize: number | undefined
  name: string | undefined
  // The first email address written, and whether it is one of the reserved example addresses a demo may keep.
  email: string | undefined
  emailIsExample: boolean
  // The day asked for, counted from tomorrow (1) and up to 14.
  day: number | undefined
  partOfDay: PartOfDay | undefined
  time: { hour: number, minute: number } | undefined
  yes: boolean
  no: boolean
  // An option's number, such as 2 for "the second".
  pick: number | undefined
  // The visitor asks whether a time is free again or to look once more.
  askAgain: boolean
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  jeden: 1, jedna: 1, dva: 2, dve: 2, tri: 3, ctyri: 4, pet: 5, sest: 6, sedm: 7, osm: 8, devet: 9, deset: 10,
}
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  prvni: 1, druhy: 2, treti: 3, ctvrty: 4, paty: 5, sesty: 6,
}

// The domains a demo may keep an address of: the reserved ones (RFC 2606 and 6761) and the example domains.
const EXAMPLE_DOMAIN = /(?:\.test|\.example|\.invalid|\.localhost|^example\.(?:com|org|net))$/i

/** Lower-cases a text and takes the accents off its letters, so a word is found whatever way it is written. */
function plain(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

/** Tells whether a pattern is found in a text. */
function has(pattern: RegExp, text: string): boolean {
  return pattern.test(text)
}

/** Reads a number written in digits or as a word. */
function readNumber(word: string | undefined): number | undefined {
  if (word === undefined) return undefined
  if (/^\d{1,2}$/.test(word)) return Number(word)
  return NUMBER_WORDS[word]
}

/** Works out the language a message looks written in. */
function languageOf(original: string, text: string): 'en' | 'cs' | undefined {
  if (/[ěščřžýáíéúůťďň]/i.test(original)) return 'cs'
  if (has(/\b(?:dobry den|chci|chtel|zitra|pozitri|prosim|rezervovat|degustac\w*|dekuji|jmenuji|ano|potvrdte|osoby|osob|odpoledne|vecer|rano|zkusim|jeste jednou)\b/, text)) return 'cs'
  if (has(/\b(?:the|please|would|hello|hi|book|tomorrow|yes|for|and|you|your|can|get|need|ignore|confirm|want)\b/, text) || has(/\bi(?:'d|'m| am| would)\b/, text)) return 'en'
  return undefined
}

/** Finds how many guests a message names. */
function partySizeOf(text: string): number | undefined {
  const after = /\b(?:for|pro)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|jeden|jedna|dva|dve|tri|ctyri|pet|sest|sedm|osm|devet|deset)\b/.exec(text)
  const before = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|jeden|jedna|dva|dve|tri|ctyri|pet|sest|sedm|osm|devet|deset)\s+(?:people|persons|guests|of us|osob\w*|lidi)\b/.exec(text)
  return readNumber(after?.[1]) ?? readNumber(before?.[1])
}

/** Finds a name after "I'm", "my name is" or "jmenuji se", from the text as written, since a name starts with a capital. */
function nameOf(original: string): string | undefined {
  const match = /(?:\bI['’]m|\bI am|\bmy name is|\bname is|\bJmenuji se|\bjmenuji se|\bJsem|\bjsem)\s+(\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)?)/u.exec(original)
  return match?.[1]
}

/** Finds the first email address in a message. */
function emailOf(original: string): { email: string | undefined, isExample: boolean } {
  const match = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(original)
  if (!match) return { email: undefined, isExample: false }
  const email = match[0].replace(/\.$/, '')
  return { email, isExample: EXAMPLE_DOMAIN.test(email.split('@')[1] ?? '') }
}

/** Finds a time of day the message asks for, such as "noon", "2:30 pm", "14:30" or "6 pm". */
function timeOf(text: string): { hour: number, minute: number } | undefined {
  if (has(/\bnoon\b/, text)) return { hour: 12, minute: 0 }
  const clock = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?/.exec(text)
  if (clock) return withMeridiem(Number(clock[1]), Number(clock[2]), clock[3])
  const hours = /\b(\d{1,2})\s*(am|pm)\b/.exec(text)
  if (hours) return withMeridiem(Number(hours[1]), 0, hours[2])
  return undefined
}

/** Turns an hour and an optional am or pm into a 24-hour time. */
function withMeridiem(hour: number, minute: number, meridiem: string | undefined): { hour: number, minute: number } {
  if (meridiem === 'pm' && hour < 12) return { hour: hour + 12, minute }
  if (meridiem === 'am' && hour === 12) return { hour: 0, minute }
  return { hour, minute }
}

/** Finds the number of an option the message names: "option 2", "the second", "3rd". */
function pickOf(text: string): number | undefined {
  const numbered = /\b(?:option|number|moznost|cislo)\s+(\d)\b/.exec(text) ?? /\b(\d)(?:st|nd|rd|th)\b/.exec(text)
  if (numbered) return Number(numbered[1])
  const ordinal = /\b(first|second|third|fourth|fifth|sixth|prvni|druhy|treti|ctvrty|paty|sesty)\b/.exec(text)
  return ordinal ? ORDINAL_WORDS[ordinal[1] ?? ''] : undefined
}

/** Reads the offering a message names. */
function offeringOf(text: string): string | undefined {
  if (has(/\bcupping\w*/, text)) return 'cupping'
  if (has(/\b(?:tasting|degustac\w*)/, text)) return 'tasting'
  if (has(/\b(?:workshop\w*|roasting|prazic\w*|prazeni)/, text)) return 'roasting-workshop'
  return undefined
}

/** Reads the day a message asks for. */
function dayOf(text: string): number | undefined {
  if (has(/\b(?:day after tomorrow|pozitri)\b/, text)) return 2
  if (has(/\b(?:tomorrow|zitra)\b/, text)) return 1
  return undefined
}

/** Reads the part of the day a message asks for. */
function partOfDayOf(text: string): PartOfDay | undefined {
  if (has(/\b(?:afternoon|odpoledne)\b/, text)) return 'afternoon'
  if (has(/\b(?:morning|rano|dopoledne)\b/, text)) return 'morning'
  if (has(/\b(?:evening|vecer)\b/, text)) return 'evening'
  return undefined
}

/** Reads a visitor's message. */
export function understand(original: string): Understood {
  const text = plain(original)
  const address = emailOf(original)
  return {
    language: languageOf(original, text),
    injection: has(/\bignor(?:e|uj)\b.{1,30}\b(?:rules|instructions|prompt|pravidla|pokyny)\b|system prompt|you are now|jailbreak|developer mode/, text),
    wantsPerson: has(/\b(?:human|real person|a person|manager|your team|clovek|cloveka|cloveku|operator|zastupce)\b/, text),
    outOfScope: has(/\b(?:refund|my order|parcel|invoice|vraceni penez|objednavk\w*|zasilk\w*|faktur\w*)\b/, text),
    offering: offeringOf(text),
    partySize: partySizeOf(text),
    name: nameOf(original),
    email: address.email,
    emailIsExample: address.isExample,
    day: dayOf(text),
    partOfDay: partOfDayOf(text),
    time: timeOf(text),
    yes: has(/\b(?:yes|yeah|yep|sure|ok|okay|go ahead|confirm|book it|that one|take it|sounds good|ano|jo|jasne|potvrdte|potvrdit|dobre|souhlasim|vyhovuje|ten chci)\b/, text),
    no: has(/\b(?:no|nope|cancel|release|never mind|ne|zrusit|uvolnit|nechci)\b/, text),
    pick: pickOf(text),
    askAgain: has(/\b(?:again|available|availability|free|check|volny|volne|znovu|jeste jednou|zkus\w*)\b/, text),
  }
}
