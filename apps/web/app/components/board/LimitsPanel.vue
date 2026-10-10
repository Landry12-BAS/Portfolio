<script setup lang="ts">
// <BoardLimitsPanel>: what a demo costs the visitor and what is left of it. It shows the visitor's
// remaining daily allowance with a bar and the time it starts again, and, in the Technical
// reading, the system's operating limits from its datasheet (the same numbers, so the board never
// states a limit the datasheet doesn't).
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { timeUntil } from '~/board-kit/quota'
import type { Quota } from '~/board-kit/quota'

const props = defineProps<{
  /** The system's operating limits, as its datasheet lists them. */
  limits: readonly { label: string, value: string }[]
  /** What is left of the visitor's day, or undefined while it is being counted. */
  quota: Quota | undefined
  /** Names what is counted, such as "Tickets left today". */
  quotaLabel: string
  /** The Brief reading shows the allowance and leaves out the table. */
  brief: boolean
  /** The current time in Unix milliseconds, so the reset countdown can be tested. */
  now?: number
}>()

const { t } = useI18n()

const left = computed(() => props.quota?.remaining ?? 0)
const share = computed(() => (props.quota && props.quota.limit > 0 ? Math.round((props.quota.remaining / props.quota.limit) * 100) : 0))
const resets = computed(() => (props.quota ? timeUntil(props.quota.resetsAt, props.now ?? Date.now()) : undefined))
const rows = computed(() => props.limits.map(row => ({ label: row.label, value: row.value })))
</script>

<template>
  <section
    class="limits"
    :aria-label="t('board.limits.title')"
  >
    <h2 class="lb-label">
      {{ t('board.limits.title') }}
    </h2>
    <p
      v-if="quota"
      class="allowance"
      data-testid="quota"
    >
      <span class="what">{{ quotaLabel }}</span>
      <span class="count">{{ t('board.limits.count', { left, total: quota.limit }) }}</span>
    </p>
    <p
      v-else
      class="allowance"
    >
      <span class="what">{{ quotaLabel }}</span>
      <span class="count">{{ t('board.limits.counting') }}</span>
    </p>
    <div
      v-if="quota"
      class="meter"
      aria-hidden="true"
    >
      <div
        class="fill"
        :style="{ width: `${share}%` }"
      />
    </div>
    <p
      v-if="quota && resets"
      class="resets"
    >
      <strong v-if="quota.remaining === 0">{{ t('board.limits.exhausted') }}</strong>
      {{ t('board.limits.resets', { hours: resets.hours, minutes: resets.minutes }) }}
    </p>
    <LbSpecTable
      v-if="!brief"
      :columns="[t('datasheet.limit'), t('datasheet.value')]"
      :rows="rows"
    />
  </section>
</template>

<style scoped>
.limits {
  display: grid;
  gap: 8px;
}

.allowance {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 2px 12px;
  font-size: 14px;
}

.count {
  font-family: var(--lb-font-mono);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.meter {
  height: 8px;
  border: 1.5px solid var(--lb-ink);
  background: var(--lb-sheet);
}

.fill {
  height: 100%;
  background: var(--lb-board-mark);
}

.resets {
  font-size: 12.5px;
  color: var(--lb-graphite);
}
</style>
