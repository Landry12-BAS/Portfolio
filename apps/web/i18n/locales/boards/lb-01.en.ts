// English text of LB-01's evaluation board: filing a ticket, the pipeline, the agent console, the
// counters and the names of the curated samples. The shell, the Scope, the check and the notices are
// in kit.en.ts. The Czech text is in lb-01.cs.ts and must have exactly these keys. Plain text: no
// markup, no @ or |.
import type { Lb01SampleId } from '#shared/data/samples/lb01'

const lb01 = {
  intro: 'File a support ticket as a Basalt & Bean customer and watch the pipeline work through it. Then act as the support agent: check each sentence of the draft against its sources, and approve it, edit it or escalate it.',
  quotaLabel: 'Tickets left today',
  compose: {
    title: 'File a ticket',
    modeLabel: 'Where the ticket comes from',
    samples: 'Curated samples',
    own: 'Your own ticket',
    samplesLegend: 'Choose a sample',
    customerWrites: 'What the customer writes',
    noRecording: 'There is no recording of this sample yet, so it would run live.',
    liveCost: 'A live run uses one of your tickets today.',
    replay: 'Replay this sample',
    runSampleLive: 'Run this sample live',
    runInstead: 'Run it live instead',
    noLive: 'This copy of the site cannot run tickets live right now.',
    customer: 'Customer',
    customerHint: 'Synthetic customers of Basalt & Bean Coffee Co.',
    language: 'Language of the ticket',
    languages: {
      en: 'English',
      cs: 'Czech',
    },
    body: 'What the customer writes',
    bodyHint: 'Up to 2000 characters.',
    counter: '{count} of {max}',
    submit: 'File ticket',
    filing: 'Filing the ticket…',
    privacy: 'Your text passes the PII redaction and the injection screen before any model reads it. Tickets and drafts are deleted after 24 hours.',
  },
  pipeline: {
    title: 'Pipeline',
    label: 'Steps of the ticket pipeline',
    states: {
      done: 'done',
      running: 'running',
      waiting: 'waiting',
      skipped: 'skipped',
      failed: 'failed',
    },
  },
  console: {
    title: 'Agent console',
    empty: 'The ticket and its draft appear here once the pipeline has finished with it.',
    working: 'The pipeline is working on the ticket.',
    from: 'From',
    category: 'Category',
    order: 'Order',
    status: 'Status',
    expires: 'Deleted after',
    statuses: {
      received: 'Received',
      processing: 'Processing',
      awaiting_approval: 'Waiting for approval',
      escalated: 'Escalated',
      sent: 'Reply recorded',
      failed: 'Pipeline failed',
    },
    categories: {
      damaged: 'Damaged, stale or faulty item',
      late: 'Late or lost delivery',
      wrong_item: 'Wrong or missing item',
      return: 'Return or refund',
      subscription: 'Subscription question or change',
      order_change: 'Change or cancel an order',
      product: 'Product question',
      other: 'Something else',
    },
    customerWrote: 'The customer wrote',
    draft: 'Draft reply',
    claimsOk: 'Claim check: every sentence is supported by its sources.',
    claimsFlagged: 'Claim check: some sentences are not supported by the sources. They are marked below.',
    cites: 'Cites source {n}',
    notSupported: 'Not supported',
    noCitation: 'no source cited',
    sources: 'Sources',
    sourceLabel: 'Source {n}',
    noDraft: 'No draft was written. A person takes over.',
    reasons: {
      injection: 'The injection screen flagged this ticket, so no draft was written. A person takes over.',
      unchecked: 'The injection screen could not check this ticket, so no draft was written. A person takes over.',
      senior_agent: 'A legal claim, an allergy, fraud or personal data: this is a senior agent\'s matter, so no draft was written.',
      no_policy: 'No policy passage covers the question, so no draft was written. A person takes over.',
      pipeline_error: 'A step of the pipeline failed, so a person takes over.',
    },
    decision: 'Decision',
    decided: {
      approve: 'Approved: the draft was recorded as the reply.',
      edit: 'Edited and approved: the edited text was recorded as the reply.',
      escalate: 'Escalated: handed to a senior agent.',
    },
    approve: 'Approve',
    edit: 'Edit',
    escalate: 'Escalate',
    editLabel: 'Edit the reply',
    sendEdited: 'Record the edited reply',
    cancelEdit: 'Cancel',
    autoSendOff: 'Auto-send is off for visitors: a decision is recorded here, and nothing is sent to anyone.',
    replayNoDecisions: 'This is a replay, so there is no ticket to decide on. Run a sample live to approve, edit or escalate a draft.',
  },
  counters: {
    title: 'Your counters',
    none: 'Your counters appear once you file a ticket.',
    tickets: 'Tickets',
    waiting: 'Waiting',
    sent: 'Replies recorded',
    escalated: 'Escalated',
    deflection: 'Deflection',
    deflectionHelp: 'The share of decided tickets answered with the draft, edited or not, instead of escalated.',
    accuracy: 'Accuracy',
    accuracyHelp: 'The share of recorded replies that were approved without an edit.',
    noData: 'no data yet',
  },
  samples: {
    'torn-bag': {
      title: 'Torn bag',
      note: 'A damaged delivery. The draft should cite the torn-bag policy and the customer\'s order.',
    },
    'late-parcel': {
      title: 'Late parcel',
      note: 'A parcel that has not arrived. The draft should cite the late-delivery policy and the order.',
    },
    'wrong-grind': {
      title: 'Wrong grind',
      note: 'The wrong grind was sent. The draft should cite the wrong-item policy.',
    },
    'other-customers-order': {
      title: 'Someone else\'s order',
      note: 'Asks about an order that is not the customer\'s. Nothing about that order may appear in the draft.',
    },
    'injection-admin-mode': {
      title: 'Injection attempt',
      note: 'Tries to take over the agent. The injection screen should hand it to a person, with no draft.',
    },
    'stale-decaf': {
      title: 'Stale decaf',
      note: 'A Czech ticket about stale coffee. The draft and its sources should be in Czech.',
    },
    'broken-grinder': {
      title: 'Broken grinder',
      note: 'A Czech ticket about a broken grinder. The draft should cite the equipment-faults policy.',
    },
    'cancel-order': {
      title: 'Cancel an order',
      note: 'A Czech request to cancel an order before it is roasted.',
    },
  } satisfies Record<Lb01SampleId, { title: string, note: string }>,
}

/** The shape the Czech LB-01 text must have. */
export type Lb01Messages = typeof lb01

export default lb01
