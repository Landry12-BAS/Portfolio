// English text of the evaluation-board kit: the shell, the limits panel, the Scope, the Turnstile
// check, the notices for what can go wrong and the replay label. Every system's board uses
// these, so a board's own locale module only holds what is particular to its system. The Czech
// text is in kit.cs.ts and must have exactly these keys. Plain text: no markup, no @ or |.

const kit = {
  title: 'Evaluation board',
  live: 'Live',
  replay: 'Replay',
  side: 'Limits and trace of the run',
  limits: {
    title: 'Limits',
    count: '{left} of {total}',
    counting: 'Counting…',
    resets: 'Starts again in {hours} h {minutes} min, at 00:00 UTC.',
    exhausted: 'None left today.',
  },
  scope: {
    title: 'The Scope',
    idle: 'Start a run and its trace appears here, step by step.',
    following: 'Following the run',
    finished: 'The run is complete',
    recorded: 'Recorded trace of the replayed run',
    stalled: 'The trace stopped arriving before the end of the run was seen',
    missing: 'There is no trace for this run. Traces are kept for 24 hours.',
    failed: 'The trace could not be read',
    steps: 'Steps',
    modelCalls: 'Model calls',
    time: 'Time',
    timeSoFar: 'Time so far',
    tableLabel: 'Trace of the run',
    caption: 'Every step, tool call and model call of the run, with its model, its tokens and its time',
    columns: {
      step: 'Step',
      kind: 'Kind',
      model: 'Model',
      tokens: 'Tokens',
      time: 'Time',
    },
    kinds: {
      run: 'Run',
      step: 'Step',
      tool: 'Tool',
      model: 'Model call',
      attempt: 'Attempt',
      other: 'Other',
    },
    status: {
      ok: 'ok',
      error: 'failed',
      skipped: 'skipped',
    },
    inside: '(inside {parent})',
    tokens: '{input} in, {output} out',
    permalink: 'Open this trace on its own page',
    copy: 'Copy link',
    copied: 'Link copied',
  },
  gate: {
    checking: 'Checking that you are a person…',
    failed: 'The check could not tell that you are a person.',
    retry: 'Try again',
  },
  notice: {
    retry: 'Try again',
    unavailable: {
      title: 'This demo is not connected',
      text: 'This copy of the site, a preview for example, has no back end for the demo. Recorded samples can still be replayed.',
    },
    verification: {
      title: 'One quick check first',
      text: 'Your own text is only sent to a model after a check that you are a person.',
    },
    quota: {
      title: 'Today\'s allowance is used up',
      text: 'Each visitor has a daily allowance, so the demos stay free for everyone.',
      resets: 'It starts again at {time}.',
    },
    rejected: {
      title: 'The demo did not accept that',
      text: 'Check what you entered and try again.',
    },
    notFound: {
      title: 'Nothing here',
      text: 'What you asked for does not exist, or it has expired. Demo data is kept for 24 hours.',
    },
    conflict: {
      title: 'That is already settled',
      text: 'This item is no longer waiting for a decision.',
    },
    upstream: {
      title: 'The system behind this demo failed',
      text: 'It did not answer properly. Try again in a moment.',
    },
    timeout: {
      title: 'The system took too long',
      text: 'The model providers may be busy. Try again in a moment.',
    },
    network: {
      title: 'Could not reach the site',
      text: 'Check your connection and try again.',
    },
    unknown: {
      title: 'Something went wrong',
      text: 'The demo hit an unexpected error. Try again in a moment.',
    },
  },
  replayBanner: {
    title: 'Replay of a recorded run',
    recordedLive: 'This is a recording of a real run, made on {date}. It is not running now.',
    recordedMock: 'This is a recording from the test mock, made on {date}. It is not a real run.',
    free: 'Nothing is sent to a model and none of your allowance is used.',
    again: 'Replay again',
    live: 'Run it live',
  },
  samples: {
    recording: {
      yes: 'Recording available',
      no: 'No recording yet',
      unknown: 'Looking for a recording…',
    },
  },
}

/** The shape the Czech kit text must have. */
export type KitMessages = typeof kit

export default kit
