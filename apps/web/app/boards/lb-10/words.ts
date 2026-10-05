// The words the board says about the lab, in the visitor's language, built from what the service sends. What the
// service sends is a closed name (a pack, a provider, a state, a verdict, a failure, a grader's kind, a gateway's
// code, a difficulty) or a number, so the words come from the locale files by name and never from the service. A
// name the page has no words for is never shown bare as if it were words: the component says that it has none and
// shows the name as data. Numbers and shares are written by Intl in the page's language, and a count that changes
// a word picks its plural form here.
import { useI18n } from 'vue-i18n'

import { formatDuration, formatShare } from '~/board-kit/format'

/** The plural forms the locale files give a counted phrase: English uses one and other, Czech one, few and other. */
type PluralForm = 'one' | 'few' | 'other'

/** The words of the board, as functions the components call. */
export interface Lb10Words {
  packTitle: (pack: string, fallback?: string) => string
  knowsPack: (pack: string) => boolean
  sampleTitle: (sample: string) => string
  providerName: (provider: string, fallback?: string) => string
  stateWord: (state: string) => string
  verdictWord: (verdict: string) => string
  verdictText: (verdict: string) => string
  failureText: (code: string) => string | undefined
  graderName: (kind: string) => string | undefined
  gatewayReason: (code: string) => string
  difficultyWord: (difficulty: string) => string
  share: (value: number) => string
  points: (value: number) => string
  duration: (ms: number) => string
  number: (value: number) => string
  counted: (key: string, count: number, values?: Record<string, unknown>) => string
}

// The providers the board names itself; any other is shown by the name the service gives.
const PROVIDER_NAMES: Readonly<Record<string, string>> = { 'groq': 'Groq', 'workers-ai': 'Cloudflare Workers AI' }

/** Builds the words for the language the page is in. */
export function useLb10Words(): Lb10Words {
  const { t, te, locale } = useI18n()

  /** Says a name by its key, or undefined when the page has no words for it. */
  function known(key: string): string | undefined {
    return te(key) ? t(key) : undefined
  }

  /** Picks the plural form the page's language uses for a count. */
  function formOf(count: number): PluralForm {
    const form = new Intl.PluralRules(locale.value).select(count)
    return form === 'one' || form === 'few' ? form : 'other'
  }

  /** Says a counted phrase in the form its count asks for. */
  function counted(key: string, count: number, values: Record<string, unknown> = {}): string {
    return t(`${key}.${formOf(count)}`, { count: number(count), ...values })
  }

  /** Writes a whole number with the page's grouping. */
  function number(value: number): string {
    return new Intl.NumberFormat(locale.value, { maximumFractionDigits: 0 }).format(value)
  }

  /** Writes a difference of shares as signed points of a hundred: "+10", "−20", "0". */
  function points(value: number): string {
    const rounded = Math.round(value * 100)
    return new Intl.NumberFormat(locale.value, { signDisplay: 'exceptZero', maximumFractionDigits: 0 }).format(rounded)
  }

  return {
    packTitle: (pack, fallback) => known(`lb10.targets.packs.${pack}.title`) ?? fallback ?? pack,
    knowsPack: pack => te(`lb10.targets.packs.${pack}.title`),
    sampleTitle: sample => known(`lb10.samples.items.${sample}.title`) ?? sample,
    providerName: (provider, fallback) => PROVIDER_NAMES[provider] ?? fallback ?? provider,
    stateWord: state => known(`lb10.run.states.${state}`) ?? state,
    verdictWord: verdict => known(`lb10.report.difference.verdictWords.${verdict}`) ?? verdict,
    verdictText: verdict => known(`lb10.report.difference.verdicts.${verdict}`) ?? verdict,
    failureText: code => known(`lb10.failures.codes.${code}`),
    graderName: kind => known(`lb10.report.graders.${kind}`),
    gatewayReason: code => known(`lb10.report.gateway.${code}`) ?? t('lb10.report.unknownGateway', { code }),
    difficultyWord: difficulty => known(`lb10.targets.difficulty.${difficulty}`) ?? difficulty,
    share: value => formatShare(value, locale.value),
    points,
    duration: ms => formatDuration(ms, locale.value),
    number,
    counted,
  }
}
