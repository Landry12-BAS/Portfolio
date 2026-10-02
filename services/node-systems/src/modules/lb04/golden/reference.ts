// The golden set's reference reviewer: scripts that answer each golden case the way a correct
// reviewer would, so the grader, the verifier and the whole pipeline can be run end to end with no
// provider key and no model. The tests use them to prove the pipeline offline, and the mock back
// end the site's tests run against uses them to play a review of a sample contract with the real
// extraction, the real verifier and the real report, so what it answers is what the service would
// answer for a model that found exactly what the golden set plants.
//
// They read the same prompts the live models read: the second model's notes and the missing
// clauses come from the request's own text, and the third model copies the wording the prompt
// suggests. A change to a prompt that stops a model finding what it needs breaks a test.
import type { ModelReply, PromptMessage } from '../analysis/model.ts'
import type { Guard } from '../analysis/pipeline.ts'
import type { Playbook } from '../playbook/playbook.ts'
import type { ReportCase } from './cases.ts'

/** What the second model's request names: the notes it must rate (`n1 | rule payment-slow | ...`) and the clauses listed as missing. */
export interface ReportRequest {
  notes: { id: string, rule: string }[]
  missing: string[]
}

/** Reads the notes the second model is shown and the missing clauses listed under them. */
export function readReportRequest(userMessage: string): ReportRequest {
  const notes = [...userMessage.matchAll(/^(n\d+) \| rule ([a-z0-9-]+) \|/gm)].map(match => ({ id: match[1] as string, rule: match[2] as string }))
  const afterMissing = userMessage.split('Missing clauses:\n')[1] ?? ''
  const missing = [...afterMissing.matchAll(/^- ([a-z0-9-]+)$/gm)].map(match => match[1] as string)
  return { notes, missing }
}

/** Reads the wording the third model's request suggests (`Suggested wording: ...`), or says there was none. */
export function readSuggestedWording(userMessage: string): string | undefined {
  return /^Suggested wording: (.+)$/m.exec(userMessage)?.[1]
}

/** What one scripted model does with a conversation. */
export type Answerer = (messages: readonly PromptMessage[]) => ModelReply

/** The three models of a review, each as a function from a conversation to its reply. */
export interface ReferenceAnswers {
  long: Answerer
  reason: Answerer
  fast: Answerer
}

/** The severity a case expects for a rule, or the playbook's own for a rule the case does not mention. */
function severityFor(entry: ReportCase, playbook: Playbook, rule: string): string {
  const planted = entry.planted.find(candidate => candidate.rule === rule)
  const absent = entry.absent.find(candidate => candidate.rule === rule)
  return planted?.severity ?? absent?.severity ?? playbook.rules.get(rule)?.severity ?? 'medium'
}

/**
 * Builds the three models' answers for a golden case: the first finds every planted passage and every
 * absent clause, the second rates each as the case says, and the third proposes the wording its prompt suggests.
 */
export function referenceAnswers(entry: ReportCase, playbook: Playbook): ReferenceAnswers {
  return {
    long: () => ({
      kind: 'json',
      value: {
        notes: entry.planted.map(planted => ({ rule: planted.rule, topic: planted.topic, clause: planted.clause, quote: planted.passage })),
        missing: entry.absent.map(absence => absence.rule),
      },
    }),
    reason: (messages) => {
      const request = readReportRequest(messages[1]?.content ?? '')
      return {
        kind: 'json',
        value: {
          findings: request.notes.map(note => ({ note: note.id, severity: severityFor(entry, playbook, note.rule), summary: `This passage goes against the playbook rule ${note.rule}.` })),
          missing: request.missing.map(rule => ({ rule, severity: severityFor(entry, playbook, rule), summary: `The contract has no clause for ${rule}.` })),
        },
      }
    },
    fast: messages => ({ kind: 'json', value: { replacement: readSuggestedWording(messages[1]?.content ?? '') ?? 'The parties agree wording that meets the playbook.' } }),
  }
}

/** A guard that says what the case expects: it flags a contract that talks to its reviewer, with the score a guard model would give. */
export function referenceGuard(entry: ReportCase): Guard {
  return { check: async () => ({ flagged: entry.screen === 'flagged', score: entry.screen === 'flagged' ? 0.97 : 0.01 }) }
}
