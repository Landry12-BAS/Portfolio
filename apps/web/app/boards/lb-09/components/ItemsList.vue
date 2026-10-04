<script setup lang="ts">
// <ItemsList>: the decisions and the action items the meeting produced, each with its owner and
// deadline when one was said, the words it rests on quoted verbatim, and the seconds it was said in.
// Every item is a button that jumps the player to its evidence and plays it: the proof is the
// recording, not the summary. The list also says how many items the checks dropped, because a
// model proposed them with evidence that was not in the transcript.
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { clockTime } from '../format'
import type { Item, Items } from '../schemas'

const props = defineProps<{
  items: Items
}>()

const emit = defineEmits<{ play: [seconds: number] }>()

const { t } = useI18n()

const decisions = computed(() => props.items.items.filter(item => item.kind === 'decision'))
const actions = computed(() => props.items.items.filter(item => item.kind === 'action'))

/** Words the seconds an item was said in. */
function spanOf(item: Item): string {
  return t('lb09.items.evidence', { start: clockTime(item.start), end: clockTime(item.end) })
}
</script>

<template>
  <section
    class="items"
    data-testid="items"
    :aria-labelledby="'lb09-items-title'"
  >
    <h2
      id="lb09-items-title"
      class="lb-label"
    >
      {{ t('lb09.items.title') }}
    </h2>

    <div class="group">
      <h3 class="group-title">
        {{ t('lb09.items.decisions') }}
      </h3>
      <p
        v-if="decisions.length === 0"
        class="note"
        data-testid="no-decisions"
      >
        {{ t('lb09.items.noneDecisions') }}
      </p>
      <ul
        v-else
        class="list"
        data-testid="decisions"
      >
        <li
          v-for="item in decisions"
          :key="item.position"
          class="item"
        >
          <button
            type="button"
            class="play"
            :aria-label="t('lb09.items.play', { text: item.text, time: clockTime(item.start) })"
            @click="emit('play', item.start)"
          >
            <LbIcon
              name="play"
              :size="16"
            />
            <span class="body">
              <span class="text">{{ item.text }}</span>
              <q class="quote">{{ item.evidence }}</q>
              <span class="span">{{ spanOf(item) }}</span>
            </span>
          </button>
        </li>
      </ul>
    </div>

    <div class="group">
      <h3 class="group-title">
        {{ t('lb09.items.actions') }}
      </h3>
      <p
        v-if="actions.length === 0"
        class="note"
        data-testid="no-actions"
      >
        {{ t('lb09.items.noneActions') }}
      </p>
      <ul
        v-else
        class="list"
        data-testid="actions"
      >
        <li
          v-for="item in actions"
          :key="item.position"
          class="item"
        >
          <button
            type="button"
            class="play"
            :aria-label="t('lb09.items.play', { text: item.text, time: clockTime(item.start) })"
            @click="emit('play', item.start)"
          >
            <LbIcon
              name="play"
              :size="16"
            />
            <span class="body">
              <span class="text">{{ item.text }}</span>
              <span class="meta">
                <span>{{ t('lb09.items.owner') }}: {{ item.owner ?? t('lb09.items.unknown') }}</span>
                <span>{{ t('lb09.items.deadline') }}: {{ item.deadline ?? t('lb09.items.unknown') }}</span>
              </span>
              <q class="quote">{{ item.evidence }}</q>
              <span class="span">{{ spanOf(item) }}</span>
            </span>
          </button>
        </li>
      </ul>
    </div>

    <p
      v-if="items.dropped > 0"
      class="note"
      data-testid="dropped"
    >
      {{ t('lb09.items.dropped', { count: items.dropped }) }}
    </p>
  </section>
</template>

<style scoped>
.items {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.group {
  display: grid;
  gap: 6px;
}

.group-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}

.note {
  font-size: 13px;
  color: var(--lb-graphite);
}

.list {
  display: grid;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.play {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  width: 100%;
  padding: 8px 10px;
  font: inherit;
  color: var(--lb-ink);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--lb-rule);
  border-radius: 4px;
}

.play:hover {
  background: var(--lb-shade);
}

.body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.text {
  font-size: 14px;
  font-weight: 600;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 13px;
}

.quote {
  font-size: 13.5px;
  font-style: italic;
  color: var(--lb-graphite);
  overflow-wrap: anywhere;
}

.span {
  font-family: var(--lb-font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--lb-graphite);
}
</style>
