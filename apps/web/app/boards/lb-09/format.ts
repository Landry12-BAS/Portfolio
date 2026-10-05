// How the board writes seconds, moments and languages: a second of the recording as minutes and
// seconds (`0:07`, `1:00`), the same whatever the language, so the transcript, the items and the
// player's labels agree with one another; a length with one decimal as the visitor's language writes
// numbers; and the language the transcriber heard, named in the visitor's language.

/** Writes a length in seconds with one decimal, as the visitor's language writes numbers: `41.1` in English, `41,1` in Czech. */
export function decimalSeconds(seconds: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(seconds)
}

// Two-letter language codes by their names in English, made once from the browser's own names when first needed.
let codesByEnglishName: Map<string, string> | undefined

/** The two-letter code of a language named in English (`English`, `english`), or undefined for a name the browser does not know. */
function codeOfEnglishName(name: string): string | undefined {
  if (codesByEnglishName === undefined) {
    const found = new Map<string, string>()
    const names = new Intl.DisplayNames('en', { type: 'language', fallback: 'none' })
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    for (const first of letters) {
      for (const second of letters) {
        const english = names.of(`${first}${second}`)
        if (english !== undefined) found.set(english.toLowerCase(), `${first}${second}`)
      }
    }
    codesByEnglishName = found
  }
  return codesByEnglishName.get(name.toLowerCase())
}

/**
 * Names the language a transcriber heard in the visitor's language, starting with a capital as a value in a table
 * does. Transcribers say it as a code (`en`, `yue`) or as a name in English (`English`, `english`), so both are
 * named again in the visitor's language; a name the browser does not know is written as it came.
 */
export function languageName(heard: string, locale: string): string {
  const given = heard.trim()
  const code = /^[a-z]{2,3}$/i.test(given) ? given.toLowerCase() : codeOfEnglishName(given)
  let name = given
  if (code !== undefined) {
    try {
      name = new Intl.DisplayNames(locale, { type: 'language' }).of(code) ?? given
    }
    catch {
      name = given
    }
  }
  return `${name.charAt(0).toLocaleUpperCase(locale)}${name.slice(1)}`
}

/** Writes a second of the recording as `m:ss`, rounded down to the second. */
export function clockTime(seconds: number): string {
  const whole = Math.max(Math.floor(seconds), 0)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

/** Tells whether a second of playback falls in a span of the recording: from its start up to, not including, its end. */
export function withinSpan(at: number, start: number, end: number): boolean {
  return at >= start && at < Math.max(end, start + 0.001)
}
