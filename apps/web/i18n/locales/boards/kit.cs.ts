// Czech text of the evaluation-board kit (kit.en.ts has the English). `satisfies` makes TypeScript
// refuse a missing or extra key. Typesetting for Czech (no line ends on a single-letter word)
// is applied once to the whole language in ../cs.ts. Plain text: no markup, no @ or |.
import type { KitMessages } from './kit.en'

const kit = {
  title: 'Vývojová deska',
  live: 'Živě',
  replay: 'Přehrání',
  side: 'Limity a záznam běhu',
  limits: {
    title: 'Limity',
    count: '{left} z {total}',
    counting: 'Počítám…',
    resets: 'Znovu se obnoví za {hours} h {minutes} min, o půlnoci UTC.',
    exhausted: 'Dnes už nic nezbývá.',
  },
  scope: {
    title: 'Scope',
    idle: 'Spusťte běh a jeho záznam se tu bude plnit krok za krokem.',
    following: 'Sleduji běh',
    finished: 'Běh je dokončen',
    recorded: 'Zaznamenaný průběh přehrávaného běhu',
    stalled: 'Záznam přestal přicházet dřív, než byl vidět konec běhu',
    missing: 'Pro tento běh není žádný záznam. Záznamy se uchovávají 24 hodin.',
    failed: 'Záznam běhu se nepodařilo načíst',
    steps: 'Kroky',
    modelCalls: 'Volání modelu',
    time: 'Čas',
    timeSoFar: 'Čas zatím',
    tableLabel: 'Záznam běhu',
    caption: 'Každý krok, volání nástroje a volání modelu v běhu, s modelem, tokeny a časem',
    columns: {
      step: 'Krok',
      kind: 'Druh',
      model: 'Model',
      tokens: 'Tokeny',
      time: 'Čas',
    },
    kinds: {
      run: 'Běh',
      step: 'Krok',
      tool: 'Nástroj',
      model: 'Volání modelu',
      attempt: 'Pokus',
      other: 'Jiné',
    },
    status: {
      ok: 'v pořádku',
      error: 'selhal',
      skipped: 'přeskočen',
    },
    inside: '(uvnitř: {parent})',
    tokens: '{input} vstup, {output} výstup',
    permalink: 'Otevřít tento záznam na vlastní stránce',
    copy: 'Kopírovat odkaz',
    copied: 'Odkaz zkopírován',
  },
  gate: {
    checking: 'Ověřuji, že jste člověk…',
    failed: 'Ověření se nepodařilo, nepoznali jsme, že jste člověk.',
    retry: 'Zkusit znovu',
  },
  notice: {
    unavailable: {
      title: 'Toto demo není připojeno',
      text: 'Tato kopie webu, například náhled, nemá pro demo žádný backend. Zaznamenané ukázky lze přesto přehrát.',
    },
    verification: {
      title: 'Nejdřív rychlé ověření',
      text: 'Váš vlastní text se pošle modelu až po ověření, že jste člověk.',
    },
    quota: {
      title: 'Dnešní kvóta je vyčerpaná',
      text: 'Každý návštěvník má denní kvótu, aby dema zůstala zdarma pro všechny.',
      resets: 'Obnoví se {time}.',
    },
    rejected: {
      title: 'Demo to nepřijalo',
      text: 'Zkontrolujte, co jste zadali, a zkuste to znovu.',
    },
    notFound: {
      title: 'Nic tu není',
      text: 'To, co hledáte, neexistuje, nebo už vypršelo. Data dema se uchovávají 24 hodin.',
    },
    conflict: {
      title: 'To už je vyřízené',
      text: 'Tato položka už na rozhodnutí nečeká.',
    },
    upstream: {
      title: 'Systém za tímto demem selhal',
      text: 'Neodpověděl správně. Zkuste to za chvíli znovu.',
    },
    timeout: {
      title: 'Systém odpovídal příliš dlouho',
      text: 'Poskytovatelé modelů mohou být vytížení. Zkuste to za chvíli znovu.',
    },
    network: {
      title: 'Web není dostupný',
      text: 'Zkontrolujte připojení a zkuste to znovu.',
    },
    unknown: {
      title: 'Něco se pokazilo',
      text: 'V demu nastala neočekávaná chyba. Zkuste to za chvíli znovu.',
    },
  },
  replayBanner: {
    title: 'Přehrání zaznamenaného běhu',
    recordedLive: 'Toto je nahrávka skutečného běhu z {date}. Právě neběží.',
    recordedMock: 'Toto je nahrávka z testovací atrapy z {date}. Není to skutečný běh.',
    free: 'Nic se neposílá modelu a nečerpá se vaše kvóta.',
    again: 'Přehrát znovu',
    live: 'Spustit naživo',
  },
  samples: {
    recording: {
      yes: 'Nahrávka je k dispozici',
      no: 'Zatím bez nahrávky',
      unknown: 'Hledám nahrávku…',
    },
  },
} satisfies KitMessages

export default kit
