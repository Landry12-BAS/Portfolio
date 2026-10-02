<script setup lang="ts">
// <ConversationFacts>: the state of the conversation in the board's side column: how many of its
// thirty messages are left, which step of the booking it is at, the language it is in, and how many
// model calls it has used so far. The Technical reading adds the steps as a list with where the
// conversation is among them. The counter is a number and a bar, so the limit is seen before it is
// reached; it is not announced with every message, since the composer says when it is the last one.
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { languageName } from '../format'
import { MESSAGES_PER_CONVERSATION } from '../wire'
import type { ConversationState, Step } from '../wire'

/** The steps a booking goes through, in order. A handoff is another way out of any of them. */
const BOOKING_STEPS: readonly Step[] = ['details', 'availability', 'hold', 'done']

const props = defineProps<{
  /** Where the conversation stands, or undefined before it has started. */
  state: ConversationState | undefined
  modelCalls: number
  /** The Brief reading leaves out the steps and the model calls. */
  brief: boolean
}>()

const { t, locale } = useI18n()

const left = computed(() => props.state?.messages_left ?? MESSAGES_PER_CONVERSATION)
const share = computed(() => Math.round((left.value / MESSAGES_PER_CONVERSATION) * 100))
const stepLabel = computed(() => (props.state ? t(`lb02.facts.steps.${props.state.step}`) : t('lb02.facts.none')))
// With a handoff the booking steps are not a path any more, so only the handoff is listed.
const chain = computed(() => {
  const current = props.state?.step
  if (current === undefined) return BOOKING_STEPS.map(step => ({ step, mark: 'waiting' as const }))
  if (current === 'handoff') return [{ step: current, mark: 'current' as const }]
  const at = BOOKING_STEPS.indexOf(current)
  return BOOKING_STEPS.map((step, index) => ({ step, mark: index < at ? ('done' as const) : index === at ? ('current' as const) : ('waiting' as const) }))
})
</script>

<template>
  <section
    class="facts"
    :aria-label="t('lb02.facts.title')"
    data-testid="facts"
  >
    <h2 class="lb-label">
      {{ t('lb02.facts.title') }}
    </h2>

    <div
      class="counter"
      data-testid="messages-left"
    >
      <p class="what">
        <span>{{ t('lb02.messages.label') }}</span>
        <span
          class="count"
          data-testid="messages-count"
        >{{ t('lb02.messages.value', { left, total: MESSAGES_PER_CONVERSATION }) }}</span>
      </p>
      <div
        class="bar"
        aria-hidden="true"
      >
        <span :style="{ inlineSize: `${share}%` }" />
      </div>
      <p
        v-if="state && left === 0"
        class="none"
      >
        {{ t('lb02.messages.none') }}
      </p>
    </div>

    <dl class="rows">
      <div>
        <dt>{{ t('lb02.facts.step') }}</dt>
        <dd data-testid="step">
          {{ stepLabel }}
        </dd>
      </div>
      <div v-if="state">
        <dt>{{ t('lb02.facts.language') }}</dt>
        <dd data-testid="language">
          {{ languageName(state.language, locale) }}
        </dd>
      </div>
      <div v-if="!brief">
        <dt>{{ t('lb02.facts.modelCalls') }}</dt>
        <dd data-testid="model-calls">
          {{ modelCalls }}
        </dd>
      </div>
    </dl>

    <template v-if="!brief">
      <h3 class="lb-label">
        {{ t('lb02.chain.title') }}
      </h3>
      <ol
        class="chain"
        data-testid="chain"
      >
        <li
          v-for="item in chain"
          :key="item.step"
          :data-mark="item.mark"
        >
          <LbIcon
            :name="item.mark === 'done' ? 'success' : item.mark === 'current' ? 'live' : 'clock'"
            :size="14"
            tone="mono"
          />
          <span>{{ t(`lb02.facts.steps.${item.step}`) }}</span>
          <span class="mark">{{ t(`lb02.chain.states.${item.mark}`) }}</span>
        </li>
      </ol>
    </template>
  </section>
</template>

<style scoped>
.facts {
  display: grid;
  gap: 10px;
  padding: 14px;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.counter {
  display: grid;
  gap: 6px;
}

.what {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  align-items: baseline;
  justify-content: space-between;
  font-size: 13px;
}

.count {
  font-family: var(--lb-font-mono);
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.bar {
  block-size: 8px;
  background: var(--lb-shade);
  border: 1px solid var(--lb-ink);
}

.bar span {
  display: block;
  block-size: 100%;
  background: var(--lb-ink);
}

.none {
  font-size: 12.5px;
  font-weight: 700;
}

.rows {
  display: grid;
  gap: 6px;
  margin: 0;
  font-size: 13px;
}

.rows div {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  justify-content: space-between;
}

.rows dt {
  color: var(--lb-graphite);
}

.rows dd {
  margin: 0;
  font-weight: 700;
}

.chain {
  display: grid;
  gap: 4px;
  padding: 0;
  margin: 0;
  font-size: 13px;
  list-style: none;
}

.chain li {
  display: flex;
  gap: 8px;
  align-items: center;
}

.chain li[data-mark="waiting"] {
  color: var(--lb-graphite);
}

.chain li[data-mark="current"] {
  font-weight: 700;
}

.mark {
  margin-left: auto;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}
</style>
