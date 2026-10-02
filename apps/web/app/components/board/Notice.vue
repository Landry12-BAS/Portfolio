<script setup lang="ts">
// <BoardNotice>: what a board says when something did not work, in words a visitor can act on:
// no back end on this deployment, the day's allowance used up, the check failed, the system
// behind the demo is slow or down, the site could not be reached. The wording comes from the
// locale files by the kind of failure, never from the response, so nothing a back end sends is
// shown as a page's own words; the one exception is a refused input, whose message says what to
// change and never repeats what was typed. The buttons are the board's.
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatMoment } from '~/board-kit/format'
import type { ProblemKind } from '~/board-kit/problem'

const props = defineProps<{
  kind: ProblemKind
  /** When a daily limit starts again, for the quota notice. */
  resetsAt?: string
  /** What the system said was wrong with an input, for the rejected notice. */
  detail?: string
}>()

const { t, locale } = useI18n()

// A failure to act on interrupts (an alert); a state to know about is announced politely (a status).
const calm = new Set<ProblemKind>(['unavailable', 'quota', 'notFound'])
const role = computed(() => (calm.has(props.kind) ? 'status' : 'alert'))
const icon = computed(() => (calm.has(props.kind) ? 'info' : 'warning'))
const resetTime = computed(() => (props.resetsAt ? formatMoment(props.resetsAt, locale.value) : undefined))
</script>

<template>
  <div
    class="notice"
    :role="role"
    :data-kind="kind"
    data-testid="notice"
  >
    <LbIcon
      :name="icon"
      :size="20"
    />
    <div class="body">
      <p class="title">
        {{ t(`board.notice.${kind}.title`) }}
      </p>
      <p class="text">
        {{ t(`board.notice.${kind}.text`) }}
        <template v-if="kind === 'quota' && resetTime">
          {{ t('board.notice.quota.resets', { time: resetTime }) }}
        </template>
      </p>
      <p
        v-if="kind === 'rejected' && detail"
        class="text"
      >
        {{ detail }}
      </p>
      <div class="actions">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.notice {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-ink);
}

.body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.title {
  font-weight: 700;
}

.text {
  font-size: 14px;
}

.actions:empty {
  display: none;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}
</style>
