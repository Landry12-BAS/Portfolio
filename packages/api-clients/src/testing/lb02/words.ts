// What the mock concierge says, in English and Czech. The receipts (a hold, a booking, a refusal, a
// handoff) are the real ones word for word (services/django-systems/lb02/messages.py), because the
// real concierge writes them from code and not from a model, so the board shows exactly these. The
// rest stands in for what the real model writes: plain sentences that fit the state of the
// conversation, fixed so a test can read them. Czech is typeset the way the real text is, with a
// non-breaking space after a one-letter word.
import { whenText } from './time.ts'

/** The two languages the mock writes in; any other is answered in English, as the real receipts are. */
export type Wording = 'en' | 'cs'

/** The kinds of message the real code writes itself (lb02/messages.py, Receipt). */
export type ReceiptKind = 'hold_placed' | 'booking_confirmed' | 'hold_expired' | 'slot_taken' | 'injection_refused' | 'unchecked' | 'handed_off' | 'message_limit' | 'budget_spent' | 'unavailable' | 'oops' | 'closed'

// A space that follows a one-letter Czech word, which must not end a line.
const SINGLE_LETTER_WORD = /\b([KkSsVvZzAaIiOoUu])\s/gu
const NO_BREAK_SPACE = String.fromCharCode(0xA0)

const RECEIPTS: Record<Wording, Record<ReceiptKind, string>> = {
  en: {
    hold_placed: 'I\'ve held {offering} on {when} for {party} for {minutes} minutes. Shall I confirm it? Just say yes. If you\'d rather not, tell me and I\'ll release it.',
    booking_confirmed: 'You\'re booked: {offering} on {when} for {party}. Your booking code is {code}. I\'ve recorded a confirmation for {to} on this page; this demo never sends real email.',
    hold_expired: 'Your hold on {when} ran out after {minutes} minutes, so that time is free again. Would you like me to look for times again?',
    slot_taken: 'Sorry, someone else has just taken that time. Shall I look for other times?',
    injection_refused: 'I can only help with booking tastings, cupping sessions and roasting workshops, and I can\'t change how I work. What would you like to book?',
    unchecked: 'I couldn\'t check that message just now, so I haven\'t acted on it. Please try again in a moment.',
    handed_off: 'I\'ve passed this conversation, with everything we\'ve said so far, to a member of our team. They\'ll pick it up from here.',
    message_limit: 'We\'ve reached the {limit} messages this demo allows in one conversation, so I\'ve passed it, with the whole transcript, to a member of our team.',
    budget_spent: 'This conversation has used all the model calls the demo allows, so I\'ve passed it, with the whole transcript, to a member of our team.',
    unavailable: 'I can\'t reach my tools at the moment, so I\'ve passed this conversation, with everything we\'ve said so far, to a member of our team.',
    oops: 'Sorry, I lost my place. Could you say that again?',
    closed: 'This conversation is finished. To book something else, please start a new chat.',
  },
  cs: {
    hold_placed: 'Termín {when} ({offering}) pro {party} je pro vás podržen na {minutes} minut. Mám ho potvrdit? Stačí napsat „ano“. Pokud ne, dejte vědět a uvolním ho.',
    booking_confirmed: 'Hotovo, máte rezervováno: {offering}, {when}, pro {party}. Kód rezervace: {code}. Potvrzení pro {to} je zaznamenáno na této stránce; demo žádný e-mail doopravdy neposílá.',
    hold_expired: 'Podržení termínu {when} po {minutes} minutách vypršelo a termín je zase volný. Mám znovu vyhledat volné termíny?',
    slot_taken: 'Tenhle termín mezitím obsadil někdo jiný. Mám vyhledat jiné termíny?',
    injection_refused: 'Umím pomoci jen s rezervací degustací, cuppingů a pražících workshopů a svá pravidla měnit nemohu. Co byste si přáli rezervovat?',
    unchecked: 'Tuhle zprávu se teď nepodařilo zkontrolovat, takže se podle ní nic nestalo. Zkuste to prosím za chvíli znovu.',
    handed_off: 'Konverzace je i s celým dosavadním přepisem předána našemu týmu. Převezme ji někdo z kolegů.',
    message_limit: 'Dosáhli jsme {limit} zpráv, které toto demo v jedné konverzaci povoluje, proto je konverzace i s celým přepisem předána našemu týmu.',
    budget_spent: 'Tato konverzace vyčerpala všechna volání modelu, která demo povoluje, proto je i s celým přepisem předána našemu týmu.',
    unavailable: 'Momentálně nemám přístup ke svým nástrojům, proto je konverzace i s celým dosavadním přepisem předána našemu týmu.',
    oops: 'Omlouvám se, ztratil se mi kontext. Můžete to prosím zopakovat?',
    closed: 'Tahle konverzace je u konce. Pro další rezervaci prosím začněte nový chat.',
  },
}

/** The sentences that stand in for the model's own words. */
export type ReplyKind = 'ask_details' | 'times' | 'one_time' | 'no_times' | 'which' | 'released' | 'nothing_to_release' | 'all_set' | 'not_offered'

const REPLIES: Record<Wording, Record<ReplyKind, string>> = {
  en: {
    ask_details: 'Happy to help! To book I need {missing}.',
    times: 'Here are the times I found for {offering}: {list}. Which one would you like me to hold?',
    one_time: 'I found {when} for {offering}. Shall I hold it?',
    no_times: 'I could not find a free time for {offering} then. These are the next free ones: {list}. Which one would you like me to hold?',
    which: 'Which of these times would you like? Tell me the time, or say its number.',
    released: 'I\'ve released the hold. Would you like me to look for other times?',
    nothing_to_release: 'There is no hold to release. Would you like me to look for times?',
    all_set: 'You\'re all set. Is there anything else I can help with?',
    not_offered: 'I can\'t book that time: it is not one of the free times I found. These are still free: {list}.',
  },
  cs: {
    ask_details: 'Rád pomohu! K rezervaci potřebuji {missing}.',
    times: 'Našel jsem tyto termíny ({offering}): {list}. Který mám podržet?',
    one_time: 'Našel jsem termín {when} ({offering}). Mám ho podržet?',
    no_times: 'V té době jsem pro {offering} žádný volný termín nenašel. Nejbližší volné jsou: {list}. Který mám podržet?',
    which: 'Který z těchto termínů chcete? Napište čas nebo číslo.',
    released: 'Blokaci jsem uvolnil. Mám vyhledat jiné termíny?',
    nothing_to_release: 'Žádná blokace k uvolnění není. Mám vyhledat termíny?',
    all_set: 'Máte vše potřebné. Mohu ještě s něčím pomoci?',
    not_offered: 'Tento termín rezervovat nemohu: není mezi volnými termíny, které jsem našel. Pořád jsou volné: {list}.',
  },
}

/** Puts a non-breaking space after every one-letter Czech word, so no line ends on one. */
export function typesetCzech(text: string): string {
  return text.replace(SINGLE_LETTER_WORD, (_, letter: string) => `${letter}${NO_BREAK_SPACE}`)
}

/** Fills the `{name}` holes of a sentence with facts. A missing fact is an error, so no sentence goes out with a hole in it. */
function fill(template: string, facts: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = facts[name]
    if (value === undefined) throw new Error(`The mock's sentence needs a fact called ${name}.`)
    return String(value)
  })
}

/** Writes a receipt in a language, as the real code does. */
export function receipt(kind: ReceiptKind, language: string, facts: Record<string, string | number> = {}): string {
  const wording: Wording = language === 'cs' ? 'cs' : 'en'
  const text = fill(RECEIPTS[wording][kind], facts)
  return wording === 'cs' ? typesetCzech(text) : text
}

/** Writes one of the sentences that stand in for the model's own words. */
export function reply(kind: ReplyKind, language: string, facts: Record<string, string | number> = {}): string {
  const wording: Wording = language === 'cs' ? 'cs' : 'en'
  const text = fill(REPLIES[wording][kind], facts)
  return wording === 'cs' ? typesetCzech(text) : text
}

/** Writes a party size as the language counts it: 1 guest, 2 guests; 1 osobu, 2 osoby, 5 osob. */
export function guests(count: number, language: string): string {
  if (language === 'cs') {
    if (count === 1) return '1 osobu'
    return count >= 2 && count <= 4 ? `${count} osoby` : `${count} osob`
  }
  return count === 1 ? '1 guest' : `${count} guests`
}

/** Writes the list of times a search found, numbered the way the concierge holds them. */
export function timeList(slots: readonly { startsAt: number, endsAt: number }[], language: string): string {
  const wording: Wording = language === 'cs' ? 'cs' : 'en'
  return slots.map((slot, index) => `${index + 1}. ${whenText(slot.startsAt, slot.endsAt, wording)}`).join('; ')
}

/** The fixed parts of the confirmation email (lb02/confirmation.py). */
export const CONFIRMATION = {
  subject: { en: 'Your Basalt & Bean booking {code}', cs: 'Vaše rezervace v Basalt & Bean {code}' },
  body: {
    en: 'Hello {name},\n\nYour booking is confirmed.\n\n{offering}\n{when} (Prague time)\nFor {party}\nBooking code: {code}\n\nThis is a demo: this message was recorded on the page and was never sent to {to}.\n\nBasalt & Bean Coffee Co.',
    cs: 'Dobrý den, {name},\n\nvaše rezervace je potvrzena.\n\n{offering}\n{when} (pražský čas)\nPro {party}\nKód rezervace: {code}\n\nToto je ukázka: zpráva byla jen zaznamenána na stránce a nikdy nebyla odeslána na {to}.\n\nBasalt & Bean Coffee Co.',
  },
} as const

/** Writes the recorded confirmation's subject and body for a booking. */
export function confirmationText(language: string, facts: Record<string, string | number>): { subject: string, body: string } {
  const wording: Wording = language === 'cs' ? 'cs' : 'en'
  const subject = fill(CONFIRMATION.subject[wording], facts)
  const body = fill(CONFIRMATION.body[wording], facts)
  return { subject, body: wording === 'cs' ? typesetCzech(body) : body }
}
