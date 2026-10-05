// The words the board says about a run, in the visitor's language, built from what the service sends.
// What the service sends is a closed name (a state, a step's action and role, a status, an outcome, a kind
// of finding, an engine, a severity, a verdict, a failure code, a bug) or a number, so the words come from
// the locale files by name and never from the service: a name the page has no words for is shown as the
// name itself. A step's own words (a path, a button's name, a text to expect) are the plan's data, from
// the shop, and are shown as quoted text inside the sentence, never as part of it.
import type { Lb07BugId, Lb07Step } from '@lb/contracts'
import { useI18n } from 'vue-i18n'

import { formatDuration } from '~/board-kit/format'

/** The words of the board, as functions the components call. */
export interface Lb07Words {
  stepText: (step: Lb07Step) => string
  stateWord: (state: string) => string
  statusWord: (status: string) => string
  outcomeWord: (outcome: string) => string
  kindWord: (kind: string) => string
  engineName: (engine: string) => string
  severityWord: (severity: string) => string
  verdictWord: (verdict: string) => string
  verdictNote: (verdict: string) => string
  failureText: (code: string) => string
  bugTitle: (bug: Lb07BugId) => string
  bugSummary: (bug: Lb07BugId) => string
  sampleTitle: (sample: string) => string
  queueText: (ahead: number) => string
  duration: (ms: number) => string
  clock: (seconds: number) => string
}

// The sentence about the queue for each form of the plural the language asks for (English has two, Czech three).
const QUEUE_KEYS = { one: 'lb07.queue.one', few: 'lb07.queue.few', other: 'lb07.queue.other' } as const

/** Builds the words for the language the page is in. */
export function useLb07Words(): Lb07Words {
  const { t, te, locale } = useI18n()

  /** Says a name by its key, or the name itself when the page has no words for it. */
  function named(group: string, name: string): string {
    const key = `lb07.${group}.${name}`
    return te(key) ? t(key) : name
  }

  /** Says one step of a plan in words, with the plan's own words quoted. */
  function stepText(step: Lb07Step): string {
    switch (step.action) {
      case 'goto': return t('lb07.steps.actions.goto', { path: step.path })
      case 'click': return t('lb07.steps.actions.click', { role: named('steps.clickRoles', step.role), name: step.name })
      case 'fill': return t('lb07.steps.actions.fill', { value: step.value, label: step.label })
      case 'select': return t('lb07.steps.actions.select', { option: step.option, label: step.label })
      case 'expectText': return t('lb07.steps.actions.expectText', { text: step.text })
      case 'expectCount': return step.name === undefined
        ? t('lb07.steps.actions.expectCount', { count: step.count, role: named('steps.roles', step.role) })
        : t('lb07.steps.actions.expectCountNamed', { count: step.count, role: named('steps.roles', step.role), name: step.name })
    }
  }

  /** Says how many runs are ahead in the queue, in the form the language's plural rules ask for. */
  function queueText(ahead: number): string {
    if (ahead <= 0) return t('lb07.queue.next')
    const form = new Intl.PluralRules(locale.value).select(ahead)
    return t(QUEUE_KEYS[form === 'one' || form === 'few' ? form : 'other'], { count: ahead })
  }

  /** Says a time in the browser as seconds, or minutes and seconds past a minute. */
  function clock(seconds: number): string {
    if (seconds < 60) return t('lb07.counters.seconds', { seconds })
    return t('lb07.counters.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
  }

  return {
    stepText,
    stateWord: state => named('states', state),
    statusWord: status => named('steps.status', status),
    outcomeWord: outcome => named('steps.outcomes', outcome),
    kindWord: kind => named('findings.kinds', kind),
    engineName: engine => named('findings.engines', engine),
    severityWord: severity => named('reports.severities', severity),
    verdictWord: verdict => named('verification.verdicts', verdict),
    verdictNote: verdict => named('verification.verdictNotes', verdict),
    failureText: code => named('failures.codes', code),
    bugTitle: bug => named('bugs', `${bug}.title`),
    bugSummary: bug => named('bugs', `${bug}.summary`),
    sampleTitle: sample => (te(`lb07.samples.${sample}.title`) ? t(`lb07.samples.${sample}.title`) : sample),
    queueText,
    duration: ms => formatDuration(ms, locale.value),
    clock,
  }
}
