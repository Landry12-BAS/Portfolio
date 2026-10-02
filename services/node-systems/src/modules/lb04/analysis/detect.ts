// Missing clauses, found by code. A `required` rule of the playbook lists phrases whose presence
// anywhere in the contract means the clause is there. When none of them occurs, with spaces, line
// breaks, hyphens, capitals and accents ignored, the clause is missing, and that is a fact about the
// text that no model can change either way: it can neither hide a missing clause nor invent one.
//
// A model may also claim that a clause is missing. The server keeps that claim only when this check
// agrees, and adds the missing clauses the model didn't mention.
import { foldQuote } from '@lb/contracts'

import type { Playbook, PlaybookRule } from '../playbook/playbook.ts'
import type { SourceIndex } from './source.ts'

/** Returns the `required` rules whose clause the contract does not have: none of their phrases occurs anywhere in its text. */
export function missingRules(index: SourceIndex, playbook: Playbook): PlaybookRule[] {
  const required = [...playbook.rules.values()].filter(rule => rule.kind === 'required')
  return required.filter(rule => !rule.phrases.some(phrase => index.whole.key.includes(foldQuote(phrase))))
}
