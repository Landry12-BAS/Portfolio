// The words a step the editor adds starts with, in the visitor's language. They are ordinary
// settings the visitor then edits, so they come from the locale files like every other text on the
// page, and a step added in Czech has Czech labels and Czech messages.
import type { DefaultTexts, StepKind } from './edit'

/** Looks a message up by its key, in the visitor's language. */
export type Translate = (key: string) => string

/** Builds the texts a new step of a kind starts with: its label is the kind's name. */
export function defaultTexts(translate: Translate, kind: StepKind): DefaultTexts {
  return {
    label: translate(`lb08.kinds.${kind}`),
    message: translate('lb08.defaults.message'),
    subject: translate('lb08.defaults.subject'),
    body: translate('lb08.defaults.body'),
    title: translate('lb08.defaults.title'),
    question: translate('lb08.defaults.question'),
  }
}
