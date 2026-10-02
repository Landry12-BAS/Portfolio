<script setup lang="ts">
// <DraftView>: a cited draft reply, one sentence at a time, with the sources it cites beside it.
// Each sentence carries numbered markers that link to its sources. A sentence the claim check
// did not accept is highlighted AND says so in words, with the reason the check gave, so a person
// reviewing the draft never has to rely on colour to see what to doubt. The draft and the sources
// are in the ticket's language, which can differ from the page's, so they are marked with it.
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Draft } from '../schemas'

const props = defineProps<{
  draft: Draft
  /** The ticket's language, which the draft and its sources are written in. */
  language: string
}>()

const { t, locale } = useI18n()

// Each source's number: its place in the list, counting from one.
const numbers = computed(() => new Map(props.draft.sources.map((source, index) => [source.id, index + 1])))
const unsupported = computed(() => props.draft.sentences.filter(sentence => !sentence.supported).length)

/** Looks up the number of a cited source, or undefined for a citation that names no listed source. */
function numberOf(id: string): number | undefined {
  return numbers.value.get(id)
}
</script>

<template>
  <div class="draft">
    <p
      class="check"
      :data-ok="unsupported === 0"
      data-testid="claim-check"
    >
      <LbIcon
        :name="unsupported === 0 ? 'success' : 'warning'"
        :size="16"
        tone="mono"
      />
      <span>{{ unsupported === 0 ? t('lb01.console.claimsOk') : t('lb01.console.claimsFlagged', { count: unsupported }) }}</span>
    </p>

    <ol
      class="sentences"
      :lang="language"
    >
      <li
        v-for="(sentence, index) in draft.sentences"
        :key="index"
        class="sentence"
        :data-supported="sentence.supported"
        data-testid="draft-sentence"
      >
        <mark v-if="!sentence.supported">{{ sentence.text }}</mark>
        <template v-else>
          {{ sentence.text }}
        </template>
        <span
          v-for="citation in sentence.citations"
          :key="citation"
          class="cites"
        >
          <a
            v-if="numberOf(citation) !== undefined"
            :href="`#source-${numberOf(citation)}`"
            class="cite"
            :aria-label="t('lb01.console.cites', { n: numberOf(citation) })"
          >[{{ numberOf(citation) }}]</a>
          <span
            v-else
            class="cite cite--missing"
          >[?]</span>
        </span>
        <span
          v-if="!sentence.supported"
          class="flag"
          :lang="locale"
        >
          <LbIcon
            name="warning"
            :size="14"
            tone="mono"
          />
          <strong>{{ t('lb01.console.notSupported') }}</strong>
          <span v-if="sentence.problem">: {{ sentence.problem }}</span>
          <span v-if="sentence.citations.length === 0"> ({{ t('lb01.console.noCitation') }})</span>
        </span>
      </li>
    </ol>

    <section
      v-if="draft.sources.length > 0"
      class="sources"
      :aria-label="t('lb01.console.sources')"
    >
      <h3 class="lb-label">
        {{ t('lb01.console.sources') }}
      </h3>
      <ol
        class="source-list"
        :lang="language"
      >
        <li
          v-for="(source, index) in draft.sources"
          :id="`source-${index + 1}`"
          :key="source.id"
          class="source"
          data-testid="source-card"
        >
          <p class="source-title">
            <span class="num">{{ t('lb01.console.sourceLabel', { n: index + 1 }) }}</span>
            {{ source.title }}
          </p>
          <p class="source-text">
            {{ source.text }}
          </p>
        </li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
.draft {
  display: grid;
  gap: 12px;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 13.5px;
  border: 1px solid var(--lb-rule);
}

.check[data-ok="false"] {
  border-color: var(--lb-ink);
}

.sentences {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.sentence {
  padding: 8px 10px;
  line-height: 1.5;
  background: var(--lb-sheet);
  border-left: 3px solid var(--lb-rule);
}

.sentence[data-supported="false"] {
  border-left: 3px solid var(--lb-ink);
}

.cite {
  margin-left: 4px;
  font-family: var(--lb-font-mono);
  font-size: 11px;
  font-weight: 700;
}

.flag {
  display: block;
  margin-top: 4px;
  font-size: 12.5px;
}

.sources {
  display: grid;
  gap: 6px;
}

.source-list {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.source {
  padding: 8px 10px;
  scroll-margin-top: 80px;
  background: var(--lb-shade);
  border: 1px solid var(--lb-rule);
}

.source:target {
  outline: 2px solid var(--lb-signal);
}

.source-title {
  font-size: 13px;
  font-weight: 700;
}

.num {
  margin-right: 8px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.source-text {
  margin-top: 4px;
  font-size: 13px;
  color: var(--lb-graphite);
}
</style>
