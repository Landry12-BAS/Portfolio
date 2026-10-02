<script setup lang="ts">
// <AnswerView>: what a question came to. Whatever the outcome, it leads with the question and how it
// ended. An answered question shows the plain-language explanation, the chart, the table and the SQL
// the system ran (the checked query, apart from what the model wrote), then the chain of steps read
// from the Scope's trace. A question a layer stopped shows which layer and which rule, the query that
// was stopped, and that nothing ran. One the model declined says so in the model's own words, and that
// no layer saw anything. One the service could not answer says it was not counted. After a correction it
// shows both queries. The Brief reading keeps the answer and leaves out the steps and the details.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatCount, formatDay, formatDuration } from '~/board-kit/format'

import type { PipelineStep } from '../pipeline'
import type { Answer, Limits } from '../schemas'
import type { AskRequest } from '../store'
import { headline } from '../verdict'

import AskNotice from './AskNotice.vue'
import AttemptList from './AttemptList.vue'
import ChainSteps from './ChainSteps.vue'
import ChartPanel from './ChartPanel.vue'
import ResultTable from './ResultTable.vue'
import SqlBlock from './SqlBlock.vue'

const props = defineProps<{
  answer: Answer
  /** The question that was asked, and where it came from. */
  asked: AskRequest | undefined
  steps: readonly PipelineStep[]
  /** The names of the steps in the visitor's language. */
  stepLabels: readonly string[]
  /** True when the trace has not arrived, so the steps cannot be marked yet. */
  stepsBlind: boolean
  /** True when the trace was looked for and is not there, so the steps will never be marked. */
  traceLost: boolean
  limits: Limits
  brief: boolean
}>()

const { t, locale } = useI18n()

const how = computed(() => headline(props.answer))
const corrected = computed(() => props.answer.outcome === 'answered' && props.answer.attempts.length > 1)
const firstStop = computed(() => props.answer.attempts[0])
// The curated questions and attacks are written in English; a visitor's own question is in their language.
const questionLanguage = computed(() => (props.asked?.source === 'sample' || props.asked?.source === 'attack' ? 'en' : undefined))
// What the model wrote, when it is not the same text as the query that ran.
const modelSql = computed(() => {
  const last = props.answer.attempts.at(-1)
  return last && props.answer.result && last.sql !== props.answer.result.sql ? last.sql : undefined
})
const showAttempts = computed(() => props.answer.attempts.length > 0 && (props.answer.outcome !== 'answered' || props.answer.attempts.length > 1))
const stopLayer = computed(() => (how.value.kind === 'stopped' ? t(`lb05.layers.items.${how.value.layer}.name`) : ''))
const stopRule = computed(() => (how.value.kind === 'stopped' ? t(`lb05.rules.${how.value.rule}`) : ''))
</script>

<template>
  <section
    id="lb05-answer"
    class="answer"
    aria-labelledby="lb05-answer-title"
    :data-outcome="answer.outcome"
    data-testid="answer"
  >
    <header class="head">
      <h2
        id="lb05-answer-title"
        class="title"
      >
        {{ t('lb05.answer.title') }}:
        <span data-testid="outcome">{{ t(`lb05.answer.outcomes.${answer.outcome}`) }}</span>
      </h2>
      <div
        v-if="asked?.question"
        class="asked"
      >
        <span class="lb-label">{{ t('lb05.answer.youAsked') }}</span>
        <blockquote
          :lang="questionLanguage"
          data-testid="asked-question"
        >
          {{ asked.question }}
        </blockquote>
      </div>
    </header>

    <AskNotice
      v-if="answer.outcome === 'unavailable'"
      kind="unavailable"
      :detail="answer.message"
    />

    <div
      v-else-if="answer.outcome === 'declined'"
      class="callout"
      data-testid="declined"
    >
      <p class="strong">
        {{ t('lb05.answer.declinedText') }}
      </p>
      <p
        v-if="answer.message"
        class="reason"
      >
        <span class="lb-label">{{ t('lb05.answer.reason') }}</span>
        <span data-testid="declined-reason">{{ answer.message }}</span>
      </p>
      <p v-if="answer.attempts.length === 0">
        {{ t('lb05.answer.declinedNoQuery') }}
      </p>
      <p v-else-if="firstStop?.stopped_by && firstStop.rule">
        {{ t('lb05.answer.declinedAfter', { layer: t(`lb05.layers.items.${firstStop.stopped_by}.name`), rule: t(`lb05.rules.${firstStop.rule}`) }) }}
      </p>
    </div>

    <div
      v-else-if="answer.outcome === 'refused'"
      class="callout"
      data-testid="refused"
    >
      <p
        v-if="how.kind === 'stopped'"
        class="strong"
        data-testid="stopped-by"
      >
        {{ t('lb05.sql.stoppedBy', { layer: stopLayer, rule: stopRule }) }}
      </p>
      <p>{{ t('lb05.answer.refusedText') }}</p>
      <p v-if="answer.attempts.length === 1">
        {{ t('lb05.answer.refusedNoRetry') }}
      </p>
    </div>

    <div
      v-if="corrected && firstStop?.stopped_by && firstStop.rule"
      class="callout"
      data-testid="corrected"
    >
      <p class="strong">
        {{ t('lb05.answer.correctedTitle') }}
      </p>
      <p>{{ t('lb05.answer.corrected', { layer: t(`lb05.layers.items.${firstStop.stopped_by}.name`), rule: t(`lb05.rules.${firstStop.rule}`) }) }}</p>
    </div>

    <section
      v-if="answer.explanation"
      class="block"
      data-testid="explanation"
    >
      <h3 class="lb-label">
        {{ t('lb05.answer.explanation') }}
      </h3>
      <p
        class="explanation"
        :lang="answer.explanation_source === 'fallback' ? 'en' : undefined"
      >
        {{ answer.explanation }}
      </p>
      <p class="source">
        {{ answer.explanation_source === 'fallback' ? t('lb05.answer.fromNumbers') : t('lb05.answer.fromModel') }}
      </p>
    </section>

    <ChartPanel
      v-if="answer.outcome === 'answered'"
      :chart="answer.chart"
    />

    <section
      v-if="answer.result"
      class="block"
    >
      <h3 class="lb-label">
        {{ t('lb05.result.title') }}
      </h3>
      <ResultTable
        :result="answer.result"
        :limits="limits"
      />
    </section>

    <section
      class="block"
      data-testid="sql"
    >
      <h3 class="lb-label">
        {{ t('lb05.sql.title') }}
      </h3>
      <template v-if="answer.result">
        <p class="source">
          <strong>{{ t('lb05.sql.ran') }}.</strong>
          {{ brief ? '' : t('lb05.sql.ranHelp') }}
        </p>
        <SqlBlock
          :sql="answer.result.sql"
          :label="t('lb05.sql.ran')"
        />
      </template>
      <p
        v-else
        class="source"
      >
        {{ t('lb05.sql.none') }}
      </p>
      <template v-if="!brief && modelSql && !showAttempts">
        <p class="source">
          <strong>{{ t('lb05.sql.wrote') }}.</strong>
          {{ t('lb05.sql.wroteHelp') }}
        </p>
        <SqlBlock
          :sql="modelSql"
          :label="t('lb05.sql.wrote')"
        />
      </template>
      <template v-if="!brief && showAttempts">
        <p class="source">
          <strong>{{ t('lb05.sql.tried') }}.</strong>
          {{ t('lb05.sql.wroteHelp') }}
        </p>
        <AttemptList :attempts="answer.attempts" />
      </template>
    </section>

    <section
      v-if="!brief"
      class="block"
      data-testid="steps"
    >
      <h3 class="lb-label">
        {{ t('lb05.steps.title') }}
      </h3>
      <p
        v-if="stepsBlind"
        class="source"
        :data-testid="traceLost ? 'steps-missing' : 'steps-pending'"
      >
        {{ traceLost ? t('lb05.steps.missing') : t('lb05.steps.pending') }}
      </p>
      <ChainSteps
        :steps="steps"
        :labels="stepLabels"
        :blind="stepsBlind"
      />
    </section>

    <section
      v-if="!brief"
      class="block"
    >
      <h3 class="lb-label">
        {{ t('lb05.answer.facts') }}
      </h3>
      <dl
        class="facts"
        data-testid="facts"
      >
        <div>
          <dt>{{ t('lb05.answer.modelCalls') }}</dt>
          <dd>{{ formatCount(answer.model_calls, locale) }}</dd>
        </div>
        <div>
          <dt>{{ t('lb05.answer.time') }}</dt>
          <dd>{{ formatDuration(answer.elapsed_ms, locale) }}</dd>
        </div>
        <div v-if="answer.result">
          <dt>{{ t('lb05.answer.tables') }}</dt>
          <dd class="code">
            {{ answer.result.tables.join(', ') }}
          </dd>
        </div>
        <div v-if="answer.result">
          <dt>{{ t('lb05.answer.joins') }}</dt>
          <dd>{{ formatCount(answer.result.joins, locale) }}</dd>
        </div>
        <div>
          <dt>{{ t('lb05.answer.asOf') }}</dt>
          <dd>{{ formatDay(answer.as_of, locale) }}</dd>
        </div>
      </dl>
    </section>
  </section>
</template>

<style scoped>
.answer {
  display: grid;
  gap: 16px;
  min-width: 0;
  padding-top: 16px;
  /* Leave room for the site's sticky toolbar when the answer is scrolled into view. */
  scroll-margin-top: 72px;
  border-top: 3px solid var(--lb-ink);
}

.head {
  display: grid;
  gap: 8px;
}

.title {
  font-size: 1.15rem;
  font-weight: 800;
}

.asked {
  display: grid;
  gap: 4px;
}

blockquote {
  padding: 8px 12px;
  margin: 0;
  font-style: italic;
  background: var(--lb-shade);
  border-left: 3px solid var(--lb-rule);
}

.callout {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-ink);
  border-left-width: 5px;
}

.strong {
  font-weight: 700;
}

.reason {
  display: grid;
  gap: 2px;
}

.block {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.explanation {
  max-width: 70ch;
  font-size: 15.5px;
}

.source {
  max-width: 70ch;
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 24px;
  margin: 0;
}

.facts div {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.facts dt {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.facts dd {
  margin: 0;
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
  font-weight: 700;
}
</style>
