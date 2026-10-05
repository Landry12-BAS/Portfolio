// The shape of LB-10's curated samples, which `scripts/samples-lb10.ts` writes into `lb10.ts`. It is a file of
// its own so the generated file holds data and nothing else.

/** How a sample changes production's prompt, kept so the board can say it in words and show the text it touches. */
export type EvalSampleEdit
  = | { kind: 'insert', after: string, line: string }
    | { kind: 'replace', text: string, with: string }
    | { kind: 'remove-lines', lines: readonly string[] }
    | { kind: 'unchanged' }

/** One curated starting point: the pack it measures, the providers it runs on, its edit, and the prompt the edit makes. */
export interface EvalSample {
  id: string
  pack: string
  providers: readonly string[]
  edit: EvalSampleEdit
  prompt: string
}
