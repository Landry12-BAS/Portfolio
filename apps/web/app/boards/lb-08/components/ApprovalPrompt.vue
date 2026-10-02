<script setup lang="ts">
// <ApprovalPrompt>: the question an approval step asks, when a run is waiting for its answer. The
// visitor plays the person who is asked (the roastery manager, finance, ...) and approves or
// rejects; the run then goes down the matching branch. Nothing is sent to anyone: the answer is
// only recorded. While a recording is replayed there is nobody to answer, and the prompt says so.
// Answering changes something, so it needs the visitor to have passed the check, like a run.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { waitingForApproval } from '../run/model'
import { stepName } from '../run/narrate'
import { useLb08Store } from '../store'

const { t, te } = useI18n()
const store = useLb08Store()
const { currentRun, runGraph, runMode, deciding, decisionProblem } = storeToRefs(store)

const asks = computed(() => (currentRun.value ? waitingForApproval(currentRun.value) : []))

/** The words for an approver. */
function approverWords(approver: string | undefined): string {
  const key = `lb08.choices.approver.${approver ?? ''}`
  return approver !== undefined && te(key) ? t(key) : (approver ?? '')
}

/** A step's name. */
function nameOf(nodeId: string): string {
  return stepName(runGraph.value, nodeId)
}
</script>

<template>
  <section
    v-if="asks.length > 0"
    class="lb8-panel ask"
    :aria-label="t('lb08.approval.title')"
    data-testid="approval"
  >
    <h3>{{ t('lb08.approval.title') }}</h3>
    <div
      v-for="step in asks"
      :key="step.nodeId"
      class="one"
    >
      <p class="question">
        <LbIcon
          name="shield"
          :size="18"
          tone="mono"
        />
        <span data-testid="approval-question">{{ t('lb08.approval.ask', { approver: approverWords(step.approver), question: step.question ?? '' }) }}</span>
      </p>
      <p class="lb8-hint">
        {{ runMode === 'live' ? t('lb08.approval.help') : t('lb08.approval.replayNone') }}
      </p>
      <div
        v-if="runMode === 'live'"
        class="lb8-row"
      >
        <button
          type="button"
          class="lb8-button lb8-button--primary"
          :disabled="deciding !== undefined"
          :aria-label="t('lb08.approval.approveLabel', { step: nameOf(step.nodeId) })"
          data-testid="approve"
          @click="store.decide(step.nodeId, 'approved')"
        >
          {{ t('lb08.approval.approve') }}
        </button>
        <button
          type="button"
          class="lb8-button"
          :disabled="deciding !== undefined"
          :aria-label="t('lb08.approval.rejectLabel', { step: nameOf(step.nodeId) })"
          data-testid="reject"
          @click="store.decide(step.nodeId, 'rejected')"
        >
          {{ t('lb08.approval.reject') }}
        </button>
        <span
          v-if="deciding === step.nodeId"
          class="lb8-hint"
          role="status"
        >{{ t('lb08.approval.working') }}</span>
      </div>
    </div>
    <BoardNotice
      v-if="decisionProblem"
      :kind="decisionProblem.kind"
      :resets-at="decisionProblem.resetsAt"
    />
  </section>
</template>

<style scoped>
.ask {
  border: 2px solid var(--lb-ink);
}

.one {
  display: grid;
  gap: 8px;
}

.question {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 15px;
  font-weight: 700;
}
</style>
