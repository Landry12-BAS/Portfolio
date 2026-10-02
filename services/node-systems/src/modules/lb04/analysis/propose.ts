// Proposing a redline for one finding. The fast model writes replacement wording, in one call: a
// redline has no repair, so a contract's review and its three redlines stay within the eight calls a
// run may make. The server then computes the difference between the contract's words and the proposal
// with code (redline.ts), so what the reader sees is exactly what would change, whatever the model
// wrote around it. When the model's answer can't be used, the playbook's own fallback wording stands in.
import { NOT_LEGAL_ADVICE } from '@lb/contracts'
import type { Lb04Finding, Lb04Redline } from '@lb/contracts'
import type { Tracer } from '@lb/common'

import type { Playbook, PlaybookRule } from '../playbook/playbook.ts'
import { redlineAnswerSchema } from './answers.ts'
import { ALIASES } from './model.ts'
import type { ReviewModels } from './model.ts'
import { readReply } from './pipeline.ts'
import { redlineMessages } from './prompts.ts'
import { diffWords, wordsOf } from './redline.ts'

/** What a redline is made from. */
export interface ProposeDeps {
  models: ReviewModels
  playbook: Playbook
  tracer: Tracer
}

/** A redline and the model calls it cost: always one. */
export interface Proposal {
  redline: Lb04Redline
  calls: 1
}

/** Tells whether a proposal changes the contract's words: a reply that only repeats the passage is no redline. */
function changesWords(original: string, proposal: string): boolean {
  return wordsOf(original).join(' ') !== wordsOf(proposal).join(' ')
}

/** Asks the fast model for replacement wording, once. Returns the wording when the answer fits its schema, and nothing when it doesn't; throws when the model can't be reached. */
async function askForWording(deps: ProposeDeps, rule: PlaybookRule, passage: string | null): Promise<string | undefined> {
  const reply = await deps.models.fast.ask(redlineMessages(rule, passage))
  const read = readReply(reply, redlineAnswerSchema)
  return 'value' in read ? read.value.replacement : undefined
}

/**
 * Proposes replacement wording for a finding and shows it as a difference from the contract's own words.
 * A missing clause has no words to replace, so its whole proposal is new text. Throws what the gateway
 * throws, and nothing for a model that answers badly: the playbook's wording is used then.
 */
export async function proposeRedline(deps: ProposeDeps, finding: Lb04Finding): Promise<Proposal> {
  const rule = deps.playbook.rules.get(finding.rule)
  if (!rule) throw new RangeError('The finding names a rule the playbook does not have.')
  const original = finding.kind === 'risk' ? finding.quote : ''
  return deps.tracer.span('propose redline', async (span) => {
    span.set('rule', rule.id)
    const wording = await askForWording(deps, rule, finding.kind === 'risk' ? finding.quote : null)
    const usable = wording !== undefined && changesWords(original, wording)
    const source: Lb04Redline['source'] = usable ? 'model' : 'playbook'
    const proposal = usable ? wording : rule.fallback
    span.set('source', source)
    const redline: Lb04Redline = { findingId: finding.id, original, proposal, diff: diffWords(original, proposal), source, notLegalAdvice: NOT_LEGAL_ADVICE }
    return { redline, calls: 1 }
  }, { attrs: { alias: ALIASES.fast } })
}
