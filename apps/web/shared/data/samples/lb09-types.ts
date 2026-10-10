// The shape of a curated sample of LB-09 Meeting Recorder: one scripted meeting of Basalt & Bean,
// spoken into audio by an offline text-to-speech, with the golden-set case that grades what the
// pipeline finds in it. It comes from the golden set's cases marked `sample: true`
// (evals/lb09/golden.yaml), the scripts they point to (data/seed/lb09) and the manifest of the
// committed audio (data/seed/lb09/audio/manifest.yaml), so the demo shows what the evals check.
// The audio file itself is copied into `public/lb09/` by the same script, so the page plays the
// very recording the back end transcribes.

/** The languages a sample may be spoken in. */
export type MeetingSampleLanguage = 'en' | 'cs'

/** One curated meeting for LB-09's demo. */
export interface MeetingSample {
  // The sample's key: the script's name, what the API takes to start it, and the name of its recording.
  id: string
  // The golden-set case that grades the pipeline on this meeting.
  goldenCase: string
  language: MeetingSampleLanguage
  // The script's title and what the meeting is about, in its own language.
  title: string
  about: string
  // The audio file the page plays, under `/lb09/`, and how long it runs as a decoder measures it.
  file: string
  seconds: number
  // How many people speak in it.
  speakers: number
  // What the golden set plants in it, so the page can say what to listen for.
  decisions: number
  actions: number
}
