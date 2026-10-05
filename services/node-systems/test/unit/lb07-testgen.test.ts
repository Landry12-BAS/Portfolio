// The generated test is written by a template from the validated plan, with every string as a JSON literal:
// a hostile step (quotes, backticks, `${}`, line breaks, a closing script tag, a comment closer) stays inert
// text inside a literal, never code. The template is also checked for the shape a reader expects, and the
// TypeScript compiler reads what it writes: one test, whose only statements besides the fixed checks are
// the plan's steps, each with exactly the plan's strings as its string literals.
import { LB07_LIMITS } from '@lb/contracts'
import type { Lb07Step } from '@lb/contracts'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { generateTest, testFilename } from '../../src/modules/lb07/agent/testgen.ts'
import { loadGolden } from '../support/lb07.ts'

const HOSTILE = ['"); process.exit(1); //', '`${process.env.SECRET}`', 'line one\nline two', '</script><script>alert(1)</script>', '*/ await evil() /*', '  separator', 'it\'s "quoted"']

// The two characters JSON leaves as they are and JavaScript and TypeScript read as the end of a line.
const LINE_SEPARATOR = String.fromCodePoint(0x20_28)
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x20_29)

// Strings a hostile goal, page or model could put in a plan, beyond what the schema lets through: the template must hold whatever it is given.
const FUZZ = [
  ...HOSTILE,
  `x${LINE_SEPARATOR}globalThis.injected = true //`,
  `x${PARAGRAPH_SEPARATOR}process.exit(1) //`,
  `x${LINE_SEPARATOR}*/ evil() /*`,
  'x\u{0}y',
  'x\r\nawait evil()',
  '\\"); evil(); //',
  '${`${evil()}`}',
  'x\u{D800}lone and \u{DC00}lone',
  `${'a'.repeat(118)}\u{1F600}`,
  '<!-- --> <![CDATA[ ]]>',
]

/** Says what a node of a parsed file is made of: its kinds in order, with every string literal written as `S`, and the texts of those literals. */
function shapeOf(node: ts.Node): { kinds: string[], strings: string[] } {
  const kinds: string[] = []
  const strings: string[] = []
  const visit = (current: ts.Node): void => {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      kinds.push('S')
      strings.push(current.text)
      return
    }
    kinds.push(ts.SyntaxKind[current.kind] ?? String(current.kind))
    ts.forEachChild(current, visit)
  }
  visit(node)
  return { kinds, strings }
}

/** The syntax errors the TypeScript compiler finds in a file. */
function syntaxErrors(source: string): string[] {
  const output = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  return (output.diagnostics ?? []).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

/** Reads a generated test with the compiler: its top-level statements, and the statements of the test's body. */
function readTest(source: string): { top: readonly ts.Statement[], body: readonly ts.Statement[] } {
  const file = ts.createSourceFile('generated.spec.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const call = file.statements.at(-1)
  if (!call || !ts.isExpressionStatement(call) || !ts.isCallExpression(call.expression)) return { top: file.statements, body: [] }
  const callback = call.expression.arguments[1]
  if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) return { top: file.statements, body: [] }
  return { top: file.statements, body: callback.body.statements }
}

/** The strings of one step, in the order the template writes them into its call. */
function stringsOf(step: Lb07Step): string[] {
  switch (step.action) {
    case 'goto': return [step.path]
    case 'click': return [step.role, step.name]
    case 'fill': return [step.label, step.value]
    case 'select': return [step.label, step.option]
    case 'expectText': return [step.text]
    case 'expectCount': return step.name === undefined ? [step.role] : [step.role, step.name]
  }
}

/** One step of each action carrying a text, made from it. */
function stepsCarrying(text: string): Lb07Step[] {
  return [
    { action: 'click', role: 'button', name: text },
    { action: 'fill', label: text, value: text },
    { action: 'select', label: text, option: text },
    { action: 'expectText', text },
    { action: 'expectCount', role: 'heading', name: text, count: 3 },
  ]
}

// The same steps with plain words: the shape a step carrying a hostile string must keep.
const PLAIN = readTest(generateTest({ goal: 'plain goal', steps: [{ action: 'goto', path: '/' }, ...stepsCarrying('plain words')], shopOrigin: 'http://127.0.0.1:8007' }))

describe('the generated test', () => {
  it('writes every golden reference plan as a test with one line per step and the three code checks', () => {
    for (const entry of loadGolden()) {
      const source = generateTest({ goal: entry.goal, steps: entry.plan, shopOrigin: 'http://127.0.0.1:8007' })
      expect(source).toContain('import { expect, test } from \'@playwright/test\'')
      expect(source).toContain('new AxeBuilder({ page })')
      expect(source).toContain('expect(consoleErrors).toEqual([])')
      expect(source).toContain('expect(failedRequests).toEqual([])')
      expect(source.match(/^ {2}\/\/ step \d+:/gm)).toHaveLength(entry.plan.length)
      expect(source.match(/^ {2}await /gm)).toHaveLength(entry.plan.length)
    }
  })

  it('keeps hostile strings inside JSON literals: no line of the file is added or broken by them', () => {
    const steps: Lb07Step[] = HOSTILE.flatMap((text): Lb07Step[] => [
      { action: 'click', role: 'button', name: text.slice(0, 120) },
      { action: 'fill', label: text.slice(0, 120), value: text.slice(0, 200) },
      { action: 'expectText', text: text.slice(0, 120) },
      { action: 'expectCount', role: 'heading', name: text.slice(0, 120), count: 3 },
    ])
    const plan: Lb07Step[] = [{ action: 'goto', path: '/' }, ...steps]
    const goal = HOSTILE.join(' ')
    const source = generateTest({ goal, steps: plan, shopOrigin: 'http://127.0.0.1:8007' })
    // Two lines per step (a comment and the call), the fixed lines around them, and nothing more: a line break in a string did not make a line.
    const fixedLines = generateTest({ goal: 'x', steps: [{ action: 'goto', path: '/' }], shopOrigin: 'http://127.0.0.1:8007' }).split('\n').length - 2
    expect(source.split('\n')).toHaveLength(fixedLines + plan.length * 2)
    for (const text of HOSTILE) {
      // The string appears only as its JSON form (with the two line separators JSON keeps raw written as escapes), whose quotes and backslashes keep it a literal.
      expect(source).toContain(JSON.stringify(text.slice(0, 120)).replaceAll(LINE_SEPARATOR, '\\u2028').replaceAll(PARAGRAPH_SEPARATOR, '\\u2029'))
      expect(source).not.toContain(`${text}\n`)
    }
    expect(source).not.toMatch(/^\s*process\.exit/m)
    expect(source).not.toContain('</script>\n')
  })

  it('keeps a line separator in a goal or a step inside its comment and its literal, where JSON leaves it raw', () => {
    const evil = `Buy a bag${LINE_SEPARATOR}globalThis.injected = true //`
    const source = generateTest({ goal: evil, steps: [{ action: 'goto', path: '/' }, { action: 'expectText', text: evil }], shopOrigin: 'http://127.0.0.1:8007' })
    // No character of the file ends a line but the line feed the template writes.
    expect(source).not.toContain(LINE_SEPARATOR)
    expect(source).not.toContain(PARAGRAPH_SEPARATOR)
    expect(source.split(/\r\n|[\n\r\u{2028}\u{2029}]/u).some(line => line.startsWith('globalThis'))).toBe(false)
  })

  it.each(FUZZ.map(text => [JSON.stringify(text).slice(0, 40), text] as const))('reads as one test whose statements are the plan\'s, with a step carrying %s', (_label, text) => {
    const steps: Lb07Step[] = [{ action: 'goto', path: '/' }, ...stepsCarrying(text)]
    const source = generateTest({ goal: text, steps, shopOrigin: 'http://127.0.0.1:8007' })

    expect(syntaxErrors(source)).toEqual([])
    const read = readTest(source)
    // Two imports and the test: nothing else at the top of the file, whatever the goal in its comment says.
    expect(read.top.map(statement => ts.SyntaxKind[statement.kind])).toEqual(['ImportDeclaration', 'ImportDeclaration', 'ExpressionStatement'])
    expect(read.body).toHaveLength(PLAIN.body.length)
    // The fixed lines before and after the steps are the template's own, whatever the plan holds.
    const fixedBefore = 5
    for (const index of [...Array.from({ length: fixedBefore }, (_, at) => at), ...Array.from({ length: 4 }, (_, at) => read.body.length - 1 - at)]) {
      expect(read.body[index]?.getText()).toBe(PLAIN.body[index]?.getText())
    }
    // Each step is one statement shaped as the same step with plain words, and its string literals are exactly the plan's strings.
    for (const [offset, step] of steps.entries()) {
      const statement = read.body[fixedBefore + offset] as ts.Statement
      const plain = PLAIN.body[fixedBefore + offset] as ts.Statement
      const shape = shapeOf(statement)
      expect(shape.kinds).toEqual(shapeOf(plain).kinds)
      expect(shape.strings).toEqual(stringsOf(step))
    }
  })

  it('refuses a plan that would make the file longer than the limit, instead of writing a file that is cut', () => {
    const long = 'x'.repeat(10_000)
    expect(() => generateTest({ goal: long, steps: [{ action: 'goto', path: '/' }, ...stepsCarrying(long)], shopOrigin: 'http://127.0.0.1:8007' })).toThrow(RangeError)
    // The longest plan the schema lets through, with the longest strings, fits.
    const longest: Lb07Step[] = Array.from({ length: LB07_LIMITS.maxPlanSteps }, (_, index): Lb07Step => (index === 0 ? { action: 'goto', path: `/${'a'.repeat(80)}` } : { action: 'fill', label: 'L'.repeat(120), value: 'V'.repeat(200) }))
    expect(generateTest({ goal: 'g'.repeat(LB07_LIMITS.maxGoalLength), steps: longest, shopOrigin: 'http://127.0.0.1:8007' }).length).toBeLessThanOrEqual(LB07_LIMITS.maxTestChars)
  })

  it('names the file from the goal, bounded and plain', () => {
    expect(testFilename('Buy two bags of Ethiopia Guji with WELCOME10!')).toBe('buy-two-bags-of-ethiopia-guji-with-welco.spec.ts')
    expect(testFilename('???')).toBe('qa-run.spec.ts')
    expect(testFilename('Café "quoted"')).toBe('cafe-quoted.spec.ts')
  })
})
