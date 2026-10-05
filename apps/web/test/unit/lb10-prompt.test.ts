// Tests for the board's own check of an edited prompt, which must say what the service will say
// (services/flask-systems/lb10/prompt_check.py): characters counted as Python counts them, plain text as Python's
// `isprintable` sees it, and exactly the pack's variables, found by the service's own pattern. And the summary of how
// an edit differs from production, and the service's refusal turned into the board's words.
import { describe, expect, it } from 'vitest'
import { checkPrompt, holdsControlCharacter, issuesFromService, lineChange, placeholdersOf, promptLength, unknownVariables, variableStates } from '~/boards/lb-10/prompt'

const VARIABLES = ['language', 'today']
const GOOD = 'Reply in {{language}}. Today is {{today}}.'

describe('the prompt check', () => {
  it('takes a prompt that keeps every variable and adds none', () => {
    expect(checkPrompt(GOOD, VARIABLES, 8_000)).toEqual([])
  })

  it('counts a letter outside the basic plane once, as the service does, though a string counts it twice', () => {
    const astral = '\u{1F600}'.repeat(10)
    expect(astral.length).toBe(20)
    expect(promptLength(astral)).toBe(10)
    // GOOD is plain ASCII, so the room it leaves is counted the same way by both.
    const room = 8_000 - GOOD.length
    expect(checkPrompt(`${GOOD}${'\u{1F600}'.repeat(room)}`, VARIABLES, 8_000)).toEqual([])
    expect(checkPrompt(`${GOOD}${'\u{1F600}'.repeat(room + 1)}`, VARIABLES, 8_000)).toEqual([{ code: 'too_long', length: 8_001, max: 8_000 }])
  })

  it('takes line breaks, returns and tabs as plain text, and nothing else that is not printable', () => {
    expect(holdsControlCharacter('one\ntwo\r\nthree\tfour')).toBe(false)
    expect(holdsControlCharacter('a bell \u0007')).toBe(true)
    expect(holdsControlCharacter('a joiner ‍')).toBe(true)
    // Python's isprintable() refuses every separator but the plain space, so a non-breaking space is not plain text there.
    expect(holdsControlCharacter('a b')).toBe(true)
    expect(holdsControlCharacter('čeština, emoji \u{1F600} a znaky')).toBe(false)
  })

  it('lists every problem at once, in the service\'s order', () => {
    const issues = checkPrompt('   \u0007 {{tomorrow}}', VARIABLES, 8_000)
    expect(issues.map(issue => issue.code)).toEqual(['not_text', 'missing_variables', 'unknown_variables'])
    expect(checkPrompt('   ', VARIABLES, 8_000).map(issue => issue.code)).toEqual(['empty', 'missing_variables'])
    expect(checkPrompt('', [], 8_000)).toEqual([{ code: 'empty' }])
  })

  it('finds variables by the service\'s pattern only: a reference with a dot or a capital letter is not one', () => {
    expect(placeholdersOf('{{trigger.orderId}} and {{check_stock.etaDays}} and {{ language }} and {{Language}}')).toEqual([])
    expect(placeholdersOf('{{a}} {{b_2}} {{a}}')).toEqual(['a', 'b_2'])
    expect(variableStates('Reply in {{language}}.', VARIABLES)).toEqual([{ name: 'language', kept: true }, { name: 'today', kept: false }])
    expect(unknownVariables('{{language}} {{tomorrow}}', VARIABLES)).toEqual(['tomorrow'])
  })

  it('says how an edit differs from production, line by line, ignoring blank lines and spacing', () => {
    expect(lineChange('a\nb\nc', 'a\nb\nc')).toEqual({ removed: 0, added: 0 })
    expect(lineChange('a\nb\nc', 'a\n\n  b  \nc')).toEqual({ removed: 0, added: 0 })
    expect(lineChange('a\nb\nc', 'a\nc\nd\ne')).toEqual({ removed: 1, added: 2 })
  })

  it('turns the service\'s refusal into the board\'s words, with the names it can see in the prompt that was sent', () => {
    const sent = 'Reply in English. {{tomorrow}}'
    expect(issuesFromService(['missing_variables', 'unknown_variables'], sent, VARIABLES, 8_000)).toEqual([
      { code: 'missing_variables', names: ['language', 'today'] },
      { code: 'unknown_variables', names: ['tomorrow'] },
    ])
    // A problem the service found and the board does not see in the prompt is still listed, without names.
    expect(issuesFromService(['missing_variables', 'empty', 'brand_new'], GOOD, VARIABLES, 8_000)).toEqual([{ code: 'missing_variables', names: [] }, { code: 'empty' }])
  })
})
