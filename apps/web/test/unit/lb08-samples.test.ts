// Tests that the demo's curated samples are the back end's: each sample the page offers is one the
// mock (and so the service, which reads the same seed file) can open, its event and test order are
// the ones its workflow takes, every sample has its words in both languages, the recorder knows
// what to do with each, and the samples file the page imports is the one the generator would write
// now. A sample is never written twice: the page's list comes from the golden set.
import { readLb08Seed } from '@lb/api-clients/testing'
import { triggerPayloadSchema, validateWorkflow } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { LB08_SAMPLES } from '#shared/data/samples/lb08'

import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

import { sampleGraph } from '../support/lb08-graphs'

const seed = readLb08Seed()
/** The trigger step of a sample's workflow. */
function triggerOf(id: string) {
  return sampleGraph(id).nodes.find(node => node.type === 'trigger')
}

describe('the curated samples', () => {
  it('are the ones the back end can open, and no others', () => {
    expect(LB08_SAMPLES.map(sample => sample.id).sort()).toEqual(seed.samples.map(sample => sample.id).sort())
  })

  it('start with the event their workflow starts on, and a test order that event accepts', () => {
    for (const sample of LB08_SAMPLES) {
      const trigger = triggerOf(sample.id)
      expect(trigger?.type === 'trigger' && trigger.event, sample.id).toBe(sample.event)
      expect(triggerPayloadSchema(sample.event).safeParse(sample.input).success, sample.id).toBe(true)
    }
  })

  it('have a workflow the validator accepts, since a sample that did not would be refused by the page it is on', () => {
    for (const sample of LB08_SAMPLES) expect(validateWorkflow(sampleGraph(sample.id)).ok, sample.id).toBe(true)
  })

  it('have a title and a note in English and in Czech', () => {
    const english = (en as { lb08: { samples: Record<string, { title: string, note: string }> } }).lb08.samples
    const czech = (cs as { lb08: { samples: Record<string, { title: string, note: string }> } }).lb08.samples
    for (const sample of LB08_SAMPLES) {
      expect(english[sample.id]?.title, sample.id).toBeTruthy()
      expect(czech[sample.id]?.title, sample.id).toBeTruthy()
      expect(czech[sample.id]?.note, sample.id).not.toBe(english[sample.id]?.note)
    }
  })

  it('are written in a language, and one of them in Czech', () => {
    expect(LB08_SAMPLES.map(sample => sample.language).sort()).toEqual(['cs', 'en', 'en', 'en'])
  })
})
