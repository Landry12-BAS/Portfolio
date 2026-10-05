// The board's own check of an edited prompt, as the visitor types: the same rules as the service's
// (services/flask-systems/lb10/prompt_check.py), so the editor can say what is wrong before anything is sent.
// The service stays the authority: it checks again and answers 422 `invalid_prompt` with every problem, which
// the editor then shows. The rules: not empty; at most the limit of characters, counted as Python counts them
// (one for each code point, so a letter outside the basic plane is one, not two); plain text (no control or
// formatting character but the line break and the tab); and exactly the pack's variables, found by the same
// pattern the service fills them with (`{{name}}`, a lowercase name). The pattern is fixed here and never built
// from a string.

/** One reason a prompt can't run, as the board says it: the service's code, with what the board can add. */
export type PromptIssue
  = | { code: 'empty' }
    | { code: 'too_long', length: number, max: number }
    | { code: 'not_text' }
    | { code: 'missing_variables', names: string[] }
    | { code: 'unknown_variables', names: string[] }

/** One of the pack's variables, and whether the prompt still names it. */
export interface VariableState {
  name: string
  kept: boolean
}

/** How an edited prompt differs from production, line by line, for the summary beside the editor. */
export interface LineChange {
  removed: number
  added: number
}

// A placeholder, as lb10/templates.py finds them: two braces around a lowercase name.
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g
// The characters Python's `str.isprintable()` refuses: control, format, surrogate, private and unassigned
// characters, and every separator but the plain space. The line break, the return and the tab are allowed.
const NOT_PRINTABLE = /[\p{C}\p{Z}]/u
const ALLOWED = new Set([' ', '\n', '\r', '\t'])

/** Counts a prompt's characters as the service does: one for each code point (a string's own length counts some twice). */
export function promptLength(text: string): number {
  return Array.from(text).length
}

/** Lists the distinct placeholders of a prompt, in the order they first appear. */
export function placeholdersOf(text: string): string[] {
  const seen: string[] = []
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? ''
    if (!seen.includes(name)) seen.push(name)
  }
  return seen
}

/** Tells whether a prompt holds a character the service does not take as plain text. */
export function holdsControlCharacter(text: string): boolean {
  for (const character of text) {
    if (NOT_PRINTABLE.test(character) && !ALLOWED.has(character)) return true
  }
  return false
}

/** Lists every reason a prompt can't run, in the service's order, or nothing when it can. */
export function checkPrompt(text: string, variables: readonly string[], maxChars: number): PromptIssue[] {
  const issues: PromptIssue[] = []
  const length = promptLength(text)
  if (text.trim() === '') issues.push({ code: 'empty' })
  if (length > maxChars) issues.push({ code: 'too_long', length, max: maxChars })
  if (holdsControlCharacter(text)) issues.push({ code: 'not_text' })
  const found = placeholdersOf(text)
  const missing = variables.filter(name => !found.includes(name))
  const unknown = found.filter(name => !variables.includes(name))
  if (missing.length > 0) issues.push({ code: 'missing_variables', names: missing })
  if (unknown.length > 0) issues.push({ code: 'unknown_variables', names: unknown })
  return issues
}

/** Says, for each of the pack's variables, whether the prompt still names it. */
export function variableStates(text: string, variables: readonly string[]): VariableState[] {
  const found = placeholdersOf(text)
  return variables.map(name => ({ name, kept: found.includes(name) }))
}

/** Lists the variables a prompt names that the pack does not have. */
export function unknownVariables(text: string, variables: readonly string[]): string[] {
  return placeholdersOf(text).filter(name => !variables.includes(name))
}

/** Counts the lines of production an edit removed and the lines it added, ignoring blank lines and the spaces around a line. */
export function lineChange(production: string, edited: string): LineChange {
  const linesOf = (text: string) => new Set(text.split('\n').map(line => line.trim()).filter(line => line !== ''))
  const before = linesOf(production)
  const after = linesOf(edited)
  return {
    removed: [...before].filter(line => !after.has(line)).length,
    added: [...after].filter(line => !before.has(line)).length,
  }
}

/**
 * Turns the service's list of problems (from a 422) into the board's, with the names the board can see in the
 * prompt that was sent. A code the board does not know is left out here; the editor says the service's own
 * sentence for it instead.
 */
export function issuesFromService(codes: readonly string[], sent: string, variables: readonly string[], maxChars: number): PromptIssue[] {
  const local = checkPrompt(sent, variables, maxChars)
  const issues: PromptIssue[] = []
  for (const code of codes) {
    const known = local.find(issue => issue.code === code)
    if (known) issues.push(known)
    else if (code === 'empty' || code === 'not_text') issues.push({ code })
    else if (code === 'too_long') issues.push({ code, length: promptLength(sent), max: maxChars })
    else if (code === 'missing_variables' || code === 'unknown_variables') issues.push({ code, names: [] })
  }
  return issues
}
