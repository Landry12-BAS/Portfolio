// English interface text, the site's default language. Every key here must exist in
// cs.ts too; TypeScript checks that. Datasheet content lives in shared/data instead.
//
// vue-i18n reads { } as placeholders and @ and | as syntax, so plain text avoids them.

import kit from './boards/kit.en'
import lb01 from './boards/lb-01.en'
import lb02 from './boards/lb-02.en'
import lb05 from './boards/lb-05.en'
import lb08 from './boards/lb-08.en'
import lb03 from './boards/lb-03.en'
import lb04 from './boards/lb-04.en'
import lb06 from './boards/lb-06.en'
import lb07 from './boards/lb-07.en'

const en = {
  site: {
    description: 'Ten live AI systems, built for one fictional coffee company and open to every visitor, with a trace of every step they take.',
    skip: 'Skip to content',
  },
  toolbar: {
    sections: 'Sections',
    systems: 'Systems',
    build: 'Build order',
    language: 'Language',
    theme: {
      group: 'Theme',
      light: 'Light theme',
      dark: 'Dark theme',
      system: 'Auto',
    },
  },
  footer: {
    folder: 'Product folder',
    allParts: 'All parts',
    note: 'Landry Bodjona · LB. Basalt & Bean Coffee Co. is fictional, and every demo runs on synthetic data.',
  },
  home: {
    title: 'Ten live AI systems',
    kicker: 'Ten live AI systems · One fictional company',
    heading: 'A portfolio you can operate',
    lede: 'Ten production-grade AI systems, built for one fictional coffee company and open to every visitor. Each one runs live on this site, shows every step it takes, and invites people to try to break it.',
    quickref: {
      label: 'Quick reference',
      stamp: 'Phase 1 in build',
      owner: 'Owner',
      systems: 'Systems',
      systemsValue: '10, on one shared platform (LB-00)',
      backends: 'Back ends',
      backendsValue: 'Django, Flask (sync and async), Node + TypeScript',
      frontend: 'Front end',
      frontendValue: 'Nuxt (Vue 3) + Pinia, in TypeScript',
      ai: 'AI',
      aiValue: 'Free tiers from Groq, Workers AI and OpenRouter, behind one gateway',
      languages: 'Languages',
      languagesValue: 'English and Czech',
      accounts: 'Accounts',
      accountsValue: 'None. Visitors stay anonymous',
    },
    guide: {
      title: 'Selection guide',
      intro: 'Filter the ten systems by back end or technique, the way engineers search a parts distributor. Select a part number to open its datasheet.',
    },
    anatomy: {
      title: 'What every system page shows',
      datasheet: 'The datasheet',
      datasheetText: 'What the system does, the problem it solves and its operating limits, in a 30-second Brief or the full Technical version.',
      board: 'The evaluation board',
      boardText: 'The live demo. It opens on curated samples with cached results, and custom input runs for real within the visitor’s daily quota.',
      scope: 'The Scope',
      scopeText: 'A trace of every run: each step, tool call, token and model, with its latency and the provider that answered.',
    },
    build: {
      title: 'Build order',
      phase: 'Phase {n}',
      platform: 'Platform',
      foundation: 'Foundation',
      foundationText: 'These touch all three back ends, the gateway, tracing, quotas and the eval harness. Everything after reuses them.',
      breadth: 'Breadth',
      breadthText: 'Real-time chat, vision, long documents and browser automation, on a stable base.',
      showpieces: 'Showpieces',
      showpiecesText: 'The most complex builds come last. Eval Lab arrives with golden sets that have been growing since Phase 1.',
    },
  },
  catalog: {
    backend: 'Back end',
    technique: 'Technique',
    all: 'All',
    filterBackend: 'Filter by back end',
    filterTechnique: 'Filter by technique',
    showing: 'Showing {visible} of {total} systems',
    clear: 'Clear filters',
    region: 'Systems',
    caption: 'The ten systems with their back end, techniques and build phase',
    part: 'Part',
    system: 'System',
    visitorAction: 'What a visitor does',
    techniques: 'Techniques',
    phase: 'Phase',
    empty: 'No system matches both filters. Clear one of them to see more.',
    backends: {
      django: 'Django',
      flask: 'Flask',
      node: 'Node + TypeScript',
    },
    techniqueNames: {
      rag: 'RAG',
      tool: 'Tool use',
      multi: 'Multi-agent',
      vision: 'Vision',
      voice: 'Voice',
      browser: 'Browser agent',
      structured: 'Structured output',
      citations: 'Citations',
      evals: 'Evals',
      multiprovider: 'Multi-provider',
      realtime: 'Real-time',
      local: 'Local model',
    },
  },
  datasheet: {
    phase: 'Phase {n}',
    size: 'Size {size}',
    readingMode: 'Reading mode',
    technical: 'Technical',
    brief: 'Brief',
    problem: 'Problem',
    tryIt: 'Try it live',
    proves: 'Proves',
    techniques: 'Techniques',
    chain: 'Signal chain',
    stack: 'Stack',
    highlights: 'Engineering highlights',
    limit: 'Operating limit',
    value: 'Value',
    status: 'Status',
    statusText: 'In build, Phase {n}. The live demo, its evaluation board and the Scope open here when this part ships.',
    otherParts: 'Other parts',
    allSystems: 'All systems',
    openBoard: 'Open the evaluation board',
    boardOpen: 'The evaluation board for this part is open. It starts on curated samples, and your own text runs live within your daily allowance.',
  },
  boardPage: {
    title: '{name}, evaluation board',
    back: 'Back to the datasheet',
    missing: 'This part has no evaluation board yet',
    missingText: 'Its datasheet is open, and its live demo arrives when the part ships.',
    loading: 'Loading the evaluation board…',
  },
  runs: {
    title: 'Trace of run {id}',
    heading: 'Trace of a run',
    lede: 'The Scope\'s record of one run: every step, tool call and model call, with its timing. Only metadata is kept, never what was typed or answered, and a trace is deleted after 24 hours.',
    system: 'System',
    runId: 'Run ID',
    back: 'Back to the catalog',
  },
  board: kit,
  lb01,
  lb02,
  lb05,
  lb08,
  lb03,
  lb04,
  lb06,
  lb07,
  error: {
    code: 'Error {code}',
    notFound: 'Part not found',
    notFoundText: 'No part in this catalog has that number. The ten systems run from LB-01 to LB-10.',
    generic: 'Something went wrong',
    genericText: 'The page could not be shown. Reload it, or go back to the catalog.',
    back: 'Back to the catalog',
  },
}

/** The shape every language's messages must have: exactly the English keys. */
export type Messages = typeof en

export default en
