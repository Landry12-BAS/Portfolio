// The workflows and test orders of LB-08's curated samples for the tests, read from the same
// seed file the mock back end and the real service read, so a test never writes a graph out a
// second time. Each call returns a copy that a test may change.
import { readLb08Seed } from '@lb/api-clients/testing'
import type { Values, WorkflowGraph } from '@lb/contracts'

const seed = readLb08Seed()

/** Returns a copy of a sample's workflow. */
export function sampleGraph(id: string): WorkflowGraph {
  const sample = seed.samples.find(candidate => candidate.id === id)
  if (!sample) throw new Error(`There is no sample called ${id}.`)
  return structuredClone(sample.graph)
}

/** Returns a copy of a sample's test order. */
export function sampleInput(id: string): Values {
  const sample = seed.samples.find(candidate => candidate.id === id)
  if (!sample) throw new Error(`There is no sample called ${id}.`)
  return { ...sample.input }
}
