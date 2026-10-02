// How the boards present curated samples: one shape for the picker, whatever the system, so each
// board only has to say what its samples are called and what they show.

/** One sample as the picker shows it. */
export interface PickerSample {
  id: string
  title: string
  /** What the sample is there to show, in a sentence. */
  note: string
  /** The language it is written in. */
  language: 'en' | 'cs'
  /** The start of what it says. */
  excerpt: string
}
