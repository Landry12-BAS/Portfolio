// LB-08's eval pack: it holds the production prompt, every build and resist case, and the committed
// file is what the code writes today (the drift check `pnpm check` runs).
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { evalsDirectory, seedDirectory } from '../../src/core/data-files.ts'
import { describeSystemPrompt, describeUserMessage } from '../../src/modules/lb08/generate/prompts.ts'
import { buildPack, checkMatchesProduction, packableCases, render } from '../../src/modules/lb08/pack/build.ts'
import { packPath, renderPack } from '../../scripts/lb08-pack.ts'

const GOLDEN = `${evalsDirectory()}/lb08/golden.yaml`

describe('the LB-08 eval pack', () => {
  const pack = buildPack(seedDirectory(), GOLDEN)

  it('carries the production system prompt and a user template that renders to the production message', () => {
    expect(pack.prompt.system).toBe(describeSystemPrompt())
    for (const entry of pack.cases) {
      expect(render(pack.prompt.user, entry.inputs)).toBe(describeUserMessage(entry.inputs.description ?? ''))
    }
  })

  it('holds every build and resist case, and no reject case, each with a grader', () => {
    const cases = packableCases(seedDirectory(), GOLDEN)
    expect(pack.cases.map(entry => entry.id)).toEqual(cases.map(entry => entry.id))
    expect(cases.every(entry => entry.kind !== 'reject')).toBe(true)
    expect(pack.cases.every(entry => entry.graders.length > 0)).toBe(true)
    expect(pack.cases.some(entry => entry.difficulty === 'hard')).toBe(true)
    expect(pack.common_graders.map(grader => grader.kind)).toEqual(['json_schema'])
  })

  it('refuses a pack whose template no longer renders what production sends', () => {
    const broken = { ...pack, prompt: { ...pack.prompt, user: '{{description}}' } }
    expect(() => checkMatchesProduction(broken, packableCases(seedDirectory(), GOLDEN))).toThrow(/renders differently/)
  })

  it('is committed as the file the script writes today', () => {
    expect(readFileSync(packPath(), 'utf8')).toBe(renderPack(pack))
  })
})
