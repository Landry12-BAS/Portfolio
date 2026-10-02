// The attacks the safety demo lists, in the shape its picker takes: the card's words (from the locale
// files, keyed by the attack's ID) together with where a query like the attack is stopped, which the
// adversarial set records. The IDs, the questions and the layers come from the generated samples, so
// the demo offers exactly what the evals check.
import { LB05_ATTACKS } from '#shared/data/samples/lb05'
import type { SqlLayer, SqlRule } from '#shared/data/sql-safety'

import type { PickerSample } from '~/board-kit/samples'

/** An attack as the safety panel lists it: the card's words, and where a query like it is stopped. */
export interface AttackItem extends PickerSample {
  stoppedBy: SqlLayer
  rule: SqlRule
}

/** Looks up a card's words by the attack's ID. */
export type Words = (key: string) => string

/** Lists the attacks with their words, in the order the evals' selection gives them. */
export function attackItems(words: Words): AttackItem[] {
  return LB05_ATTACKS.map(attack => ({
    id: attack.id,
    title: words(`lb05.attacks.${attack.id}.title`),
    note: words(`lb05.attacks.${attack.id}.note`),
    language: 'en',
    excerpt: attack.question,
    stoppedBy: attack.stoppedBy,
    rule: attack.rule,
  }))
}
