// English text of LB-09's evaluation board: the two sources (a curated meeting, the visitor's own
// recording), the two modes, the recorder with what it says before it asks for the microphone and
// each way it can fail, the progress stages, the transcript, the items with their evidence, the
// exports, the facts of a meeting and the names of the curated meetings. The shell, the Scope, the
// check and the notices are in kit.en.ts. The Czech text is in lb-09.cs.ts and must have exactly
// these keys. Plain text: no markup, no @ or |, and no plural forms (a count is written as
// "Speakers: 4", which reads the same in every language).
import type { Lb09SampleId } from '#shared/data/samples/lb09'

const lb09 = {
  intro: 'Play a sample meeting or record up to a minute of your own, pick fast or private mode, and follow the worker stage by stage. Then read the transcript, and click a decision or an action item to hear the second it was said.',
  quotaLabel: 'Recordings left today',
  source: {
    label: 'Where the meeting comes from',
    sample: 'A sample meeting',
    record: 'Your own recording',
  },
  modes: {
    label: 'How to transcribe',
    fast: 'Fast mode',
    private: 'Private mode',
    fastNote: 'Fast mode sends the audio through the AI gateway to a speech model that does not train on it, and deletes it once transcribed.',
    privateNote: 'Private mode transcribes on our own server with faster-whisper. The audio never leaves the box, and it takes longer.',
  },
  samples: {
    title: 'A sample meeting',
    legend: 'Choose a meeting',
    facts: 'Speakers: {speakers} · Length: {seconds} s · Decisions: {decisions} · Actions: {actions}',
    noRecording: 'There is no recording of this meeting yet, so it would run live.',
    liveCost: 'A live run uses one of your recordings today.',
    noLive: 'This copy of the site cannot run meetings live right now.',
    noAllowance: 'Today\'s recordings are used up, so live runs are off until the count starts again. Recorded meetings can still be replayed.',
    replay: 'Replay this meeting',
    runLive: 'Run this meeting live',
    names: {
      'monday-roasting-plan': {
        title: 'Monday roasting plan',
        note: 'Four people plan Monday\'s roast: which coffee goes first, who orders the bags and who prepares the roast profile. Two decisions and three actions.',
      },
      'weekend-staffing': {
        title: 'Weekend staffing',
        note: 'Who covers the Saturday market stall, and a joke that nobody should write down as a task. One action.',
      },
      'newsletter-draft': {
        title: 'Newsletter draft',
        note: 'Who writes the customer newsletter and when it goes out, with a line aimed at the assistant that must not become an item.',
      },
    } satisfies Record<Lb09SampleId, { title: string, note: string }>,
  },
  recorder: {
    title: 'Your own recording',
    explain: {
      ask: 'When you press Record, the browser asks you for the microphone. Nothing is asked before that.',
      stays: 'The audio stays in this page until you choose to send it. You can listen back first, or discard it.',
      minute: 'A recording is {seconds} seconds at most; it stops by itself at the limit.',
      deleted: 'Once sent, the audio is transcribed and deleted. It is never stored, logged or kept in the trace.',
    },
    asking: 'Waiting for the microphone…',
    recordingStarted: 'Recording. It stops by itself after a minute.',
    recorded: 'Recorded {seconds} seconds. Listen back, send it, or discard it.',
    unsupported: 'This browser cannot record audio, so there is nothing to send from it. The sample meetings still work, in every browser.',
    denied: {
      text: 'The browser did not give this page the microphone, so nothing was recorded.',
      how: 'To record, allow the microphone for this site in the browser\'s address bar or its site settings, then press Record again. Or play a sample meeting instead.',
    },
    failed: {
      no_microphone: 'No microphone was found. Plug one in, or play a sample meeting instead.',
      in_use: 'The microphone could not be read. Another app may be using it; close it and try again.',
      recorder: 'The browser could not record. Try again, or play a sample meeting instead.',
      empty: 'The recording came out empty. Try again, and say something before stopping.',
    },
    countdown: '{left} s left of {max}',
    level: 'Sound level',
    record: 'Record',
    again: 'Record again',
    stop: 'Stop',
    unreadable: 'The browser wrote the recording in a format the recorder does not take, so it cannot be sent. Try another browser, or play a sample meeting.',
    listen: 'Listen back',
    noAllowance: 'Today\'s recordings are used up, so this one cannot be sent until the count starts again.',
    noLive: 'This copy of the site cannot take recordings right now.',
    liveCost: 'Sending uses one of your recordings today.',
    send: 'Send this recording',
    discard: 'Discard',
    privacy: 'Do not record personal data. The transcript goes to a language model through the AI gateway to label the speakers and find the items; the trace of a run holds counts and stages only, never your words or your audio.',
  },
  player: {
    own: 'Your recording',
    sample: 'The sample meeting',
  },
  progress: {
    title: 'Working through the meeting',
    replaying: 'Replaying the recorded run',
    checking: 'Checking that you are a person…',
    done: 'The meeting is done',
    failedTitle: 'The meeting could not be finished',
    stages: {
      decoding: 'Decode',
      transcribing: 'Transcribe',
      labelling: 'Label speakers',
      extracting: 'Extract items',
      aligning: 'Align evidence',
    },
    marks: {
      waiting: 'not yet',
      running: 'running',
      done: 'done',
      failed: 'failed',
    },
    feed: {
      socket: 'Progress arrives over a WebSocket as the worker reports each stage.',
      polling: 'The WebSocket is not available, so the meeting is read again every second or two instead.',
      replay: 'The stages play from the recording; nothing is sent.',
    },
    failures: {
      undecodable: 'The audio could not be decoded. The recorder takes WebM, Ogg, MP4, WAV and MP3.',
      too_long: 'The recording is longer than a minute, so it was refused.',
      too_short: 'The recording is shorter than half a second, so there was nothing to transcribe.',
      decode_limit: 'Decoding the audio took more time or memory than a recording is allowed, so it was stopped.',
      no_speech: 'No speech was heard in the recording.',
      transcriber: 'The transcriber could not transcribe the audio. Try again, or the other mode.',
      model: 'The model\'s answer did not fit what the recorder checks for, twice, so the meeting was not finished.',
      audio_gone: 'The audio was gone before it could be transcribed. Send it again.',
      stale: 'The meeting waited too long for a worker and was given up on. Send it again.',
      pipeline_error: 'Something went wrong while the meeting was worked on. Send it again.',
    },
    elapsed: '{elapsed} s so far',
  },
  transcript: {
    title: 'Transcript',
    labelsNote: 'Speaker labels are inferred from the words, not matched to voices: the transcriber hears one stream, and a model guessed who spoke from what was said. A speaker gets a name only when they introduce themselves.',
    empty: 'The transcript is empty.',
    jump: '{label} at {time}: jump the player here',
  },
  items: {
    title: 'Decisions and actions',
    decisions: 'Decisions',
    actions: 'Action items',
    noneDecisions: 'No decision was made in this meeting.',
    noneActions: 'No action item was given in this meeting.',
    owner: 'Owner',
    deadline: 'Deadline',
    unknown: 'not said',
    evidence: 'Said at {start} to {end}',
    play: 'Play "{text}" from {time}',
    dropped: 'Items dropped by the checks: {count}. The model proposed them with evidence that is not in the transcript, so they are not shown.',
  },
  export: {
    title: 'Export',
    note: 'Made in the browser from what is on the page, so a replay exports the same thing a live run does. Every export says the speaker labels were inferred from the words.',
    formatLabel: 'Format',
    formats: {
      json: 'JSON',
      csv: 'CSV',
      text: 'Follow-up for LB-08',
    },
    contentLabel: 'The export',
    copy: 'Copy',
    copied: 'Copied',
    download: 'Save {name}',
    lb08: 'Paste the follow-up into Automation Studio (LB-08), which turns a workflow described in words into steps.',
    openLb08: 'Open LB-08\'s board',
  },
  facts: {
    title: 'This meeting',
    none: 'No meeting yet.',
    mode: 'Mode',
    modes: {
      fast: 'Fast, through the gateway',
      private: 'Private, on our server',
    },
    audio: 'Audio',
    audioValue: 'Deleted once transcribed',
    transcriber: 'Transcriber',
    language: 'Language heard',
    duration: 'Length',
    seconds: '{seconds} s',
    modelCalls: 'Model calls',
    dropped: 'Items dropped',
    unknown: 'not yet known',
    labels: 'Speaker labels are inferred from the words, not matched to voices.',
  },
}

/** The shape the Czech LB-09 text must have. */
export type Lb09Messages = typeof lb09

export default lb09
