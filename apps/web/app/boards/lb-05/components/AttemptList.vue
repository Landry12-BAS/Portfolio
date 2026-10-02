<script setup lang="ts">
// <AttemptList>: every query the model tried for a question, in order, with what became of each: it
// ran, or a layer stopped it for a rule. The SQL is the model's own text, shown as text and never run;
// the layer's message about it is the back end's own sentence, in English, and is labelled as such.
import { LbIcon } from '@lb/icons'
import { useI18n } from 'vue-i18n'

import type { Attempt } from '../schemas'

import SqlBlock from './SqlBlock.vue'

defineProps<{
  attempts: readonly Attempt[]
}>()

const { t } = useI18n()
</script>

<template>
  <ol
    class="attempts"
    :aria-label="t('lb05.sql.tried')"
    data-testid="attempts"
  >
    <li
      v-for="(attempt, index) in attempts"
      :key="index"
      class="attempt"
      :data-stopped="attempt.stopped_by ?? 'no'"
      data-testid="attempt"
    >
      <p class="head">
        <span class="number">{{ t('lb05.sql.attempt', { n: index + 1 }) }}</span>
        <span
          v-if="attempt.stopped_by && attempt.rule"
          class="verdict stopped"
          data-testid="attempt-verdict"
        >
          <LbIcon
            name="shield"
            :size="16"
            tone="mono"
          />
          {{ t('lb05.sql.stoppedBy', { layer: t(`lb05.layers.items.${attempt.stopped_by}.name`), rule: t(`lb05.rules.${attempt.rule}`) }) }}
        </span>
        <span
          v-else
          class="verdict"
          data-testid="attempt-verdict"
        >
          <LbIcon
            name="success"
            :size="16"
            tone="mono"
          />
          {{ t('lb05.sql.ranOk') }}
        </span>
      </p>
      <SqlBlock
        :sql="attempt.sql"
        :label="t('lb05.sql.attempt', { n: index + 1 })"
      />
      <p
        v-if="attempt.message"
        class="message"
      >
        <span class="lb-label">{{ t('lb05.sql.theirWords') }}</span>
        <span
          lang="en"
          data-testid="attempt-message"
        >{{ attempt.message }}</span>
      </p>
    </li>
  </ol>
</template>

<style scoped>
.attempts {
  display: grid;
  gap: 12px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.attempt {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
}

.number {
  font-family: var(--lb-font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.verdict {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 13.5px;
}

.stopped {
  font-weight: 700;
}

.message {
  display: grid;
  gap: 2px;
  font-size: 13px;
  color: var(--lb-graphite);
}
</style>
