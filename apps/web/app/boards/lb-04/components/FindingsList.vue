<script setup lang="ts">
// <FindingsList>: the report's findings, the most serious first, each as a card. It can be narrowed to one
// topic from the radar's table, and says so, with a button to show them all again. A review that found
// nothing says that plainly and adds what that does and does not mean: no finding is not a clearance, and
// the reader is a reading aid and not legal advice. Which finding is selected, and which redline is
// being made, belong to the board; this only draws them and passes the visitor's choices up.
import type { Lb04Finding, Lb04Redline, Lb04Topic } from '@lb/contracts'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { filterFindings, sortFindings } from '../findings'
import FindingCard from './FindingCard.vue'

const props = defineProps<{
  findings: readonly Lb04Finding[]
  redlines: readonly Lb04Redline[]
  topic: Lb04Topic | undefined
  selectedId: string | undefined
  canRedline: boolean
  redlining: string | undefined
  live: boolean
  brief: boolean
}>()

const emit = defineEmits<{ show: [id: string], redline: [id: string], clear: [] }>()

const { t } = useI18n()

const sorted = computed(() => sortFindings(props.findings))
const shown = computed(() => filterFindings(sorted.value, { topic: props.topic }))

/** Finds the redline made for a finding. */
function redlineOf(id: string): Lb04Redline | undefined {
  return props.redlines.find(redline => redline.findingId === id)
}
</script>

<template>
  <section
    class="lb4-section"
    aria-labelledby="lb4-findings-heading"
    data-testid="findings"
  >
    <h2 id="lb4-findings-heading">
      {{ t('lb04.findings.title') }}
    </h2>

    <div
      v-if="findings.length === 0"
      class="lb4-panel empty"
      data-testid="no-findings"
    >
      <p class="strong">
        {{ t('lb04.findings.none') }}
      </p>
      <p class="lb4-hint">
        {{ t('lb04.findings.noneNote') }}
      </p>
    </div>

    <template v-else>
      <p
        class="count lb4-nums"
        role="status"
      >
        {{ topic ? t('lb04.findings.countTopic', { shown: shown.length, total: findings.length, topic: t(`lb04.topics.${topic}`) }) : t('lb04.findings.count', { total: findings.length }) }}
        <button
          v-if="topic"
          type="button"
          class="lb4-button lb4-button--quiet"
          @click="emit('clear')"
        >
          {{ t('lb04.findings.showAll') }}
        </button>
      </p>
      <ol class="list">
        <li
          v-for="finding in shown"
          :key="finding.id"
        >
          <FindingCard
            :finding="finding"
            :selected="selectedId === finding.id"
            :redline="redlineOf(finding.id)"
            :can-redline="canRedline"
            :redlining="redlining === finding.id"
            :live="live"
            :brief="brief"
            @show="emit('show', $event)"
            @redline="emit('redline', $event)"
          />
        </li>
      </ol>
    </template>
  </section>
</template>

<style scoped>
.list {
  display: grid;
  gap: 10px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.count {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  font-size: 13.5px;
}

.strong {
  font-weight: 700;
}
</style>
