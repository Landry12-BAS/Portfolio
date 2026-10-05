// Unit tests for reading a provider's transcription: the two answer shapes become one, and
// an answer the gateway cannot stand behind is refused instead of passed on.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { readTranscript } from '../../src/audio/transcript.ts'
import { loadRouting } from '../../src/routing/load.ts'
import type { Model } from '../../src/routing/load.ts'
import { groqTranscription, workersTranscription } from '../support/fake-provider.ts'

const routing = loadRouting(readFileSync(new URL('../../routing.yaml', import.meta.url), 'utf8'), {
  GROQ_API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'acc123', OPENROUTER_API_KEY: 'k', NVIDIA_API_KEY: 'k',
})
const groq = routing.models.get('groq/whisper-large-v3-turbo') as Model
const workers = routing.models.get('workers-ai/whisper-large-v3-turbo') as Model

describe('reading Groq\'s answer', () => {
  it('keeps the words and times, numbers the segments and drops what the gateway does not use', () => {
    const answer = readTranscript(groqTranscription([[0, 2.4, 'Good morning, everyone.'], [2.4, 5, 'Let us start.']]), groq, 5)

    expect(answer).toEqual({
      task: 'transcribe',
      language: 'English',
      duration: 5,
      text: 'Good morning, everyone. Let us start.',
      segments: [
        { id: 0, start: 0, end: 2.4, text: 'Good morning, everyone.', avg_logprob: -0.2, no_speech_prob: 0.01 },
        { id: 1, start: 2.4, end: 5, text: 'Let us start.', avg_logprob: -0.2, no_speech_prob: 0.01 },
      ],
    })
  })

  it('takes the duration from the recording, whatever the provider says', () => {
    const answer = readTranscript({ ...groqTranscription([[0, 1, 'Hello.']]), duration: 9_999 }, groq, 5)

    expect(answer?.duration).toBe(5)
  })

  it('answers an empty transcript for a recording with no speech', () => {
    expect(readTranscript(groqTranscription([]), groq, 5)).toMatchObject({ text: '', segments: [] })
  })
})

describe('reading Workers AI\'s answer', () => {
  it('reads the same words out of Cloudflare\'s envelope, and the language from its own field', () => {
    const answer = readTranscript(workersTranscription([[0, 2, 'Good morning.'], [2, 4, 'Plan for Monday.']]), workers, 5)

    expect(answer).toMatchObject({ language: 'en', duration: 5, text: 'Good morning. Plan for Monday.' })
    expect(answer?.segments.map(segment => [segment.id, segment.start, segment.end])).toEqual([[0, 0, 2], [1, 2, 4]])
  })

  it('refuses an answer outside the envelope, or one without segments', () => {
    expect(readTranscript(groqTranscription([[0, 1, 'Hello.']]), workers, 5)).toBeUndefined()
    expect(readTranscript({ success: true, result: { text: 'Hello.' } }, workers, 5)).toBeUndefined()
    expect(readTranscript({ success: false, result: { text: '', segments: [] } }, workers, 5)).toBeUndefined()
  })
})

describe('holding a provider to the recording', () => {
  it('cuts a segment that ends after the recording, and drops one that starts after it', () => {
    const answer = readTranscript(groqTranscription([[0, 3, 'First.'], [3, 30, 'Second.'], [31, 33, 'Invented.']]), groq, 5)

    expect(answer?.segments.map(segment => [segment.text, segment.start, segment.end])).toEqual([['First.', 0, 3], ['Second.', 3, 5]])
  })

  it('drops empty segments and puts the rest in order of their start', () => {
    const answer = readTranscript(groqTranscription([[3, 4, 'Later.'], [1, 2, '  '], [0, 1, 'Earlier.']]), groq, 5)

    expect(answer?.segments.map(segment => [segment.id, segment.text])).toEqual([[0, 'Earlier.'], [1, 'Later.']])
  })

  it('refuses a segment that ends before it starts', () => {
    expect(readTranscript(groqTranscription([[2, 1, 'Backwards.']]), groq, 5)).toBeUndefined()
  })

  it('refuses a probability that is not one, an answer that is not an object and too many segments', () => {
    const odd = groqTranscription([[0, 1, 'Hello.']])
    ;(odd.segments as Record<string, unknown>[])[0]!.no_speech_prob = 7
    expect(readTranscript(odd, groq, 5)).toBeUndefined()
    expect(readTranscript('transcribed', groq, 5)).toBeUndefined()
    expect(readTranscript(groqTranscription(Array.from({ length: 601 }, (_, index) => [0, 1, `Word ${index}.`] as [number, number, string])), groq, 5)).toBeUndefined()
  })
})
