<script setup lang="ts">
// <ApprovalCard>: the one place where the visitor changes the shop. When the commander has a
// proposal, the card says it in words, why, and what it touches in plain words (its blast radius),
// and waits: nothing in the simulation changes until the visitor approves, and the service checks the
// answer against the proposal that is waiting, so an answer to a proposal that is gone does nothing.
// Rejecting sends the agents back to work, for up to three proposals in all. When no proposal waits,
// the card keeps a short record of what was decided and applied. In a replay there is nobody to ask,
// and the card says so.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLb06Store } from '../store'
import { useLb06Words } from '../words'
import ProblemNotice from './ProblemNotice.vue'

defineProps<{
  /** The Brief reading leaves out the hypothesis the proposal follows. */
  brief: boolean
}>()

const { t } = useI18n()
const words = useLb06Words()
const store = useLb06Store()
const { pending, runMode, busy, decisionProblem, events } = storeToRefs(store)

const action = computed(() => (pending.value ? words.actionText(pending.value.action) : ''))

/** What was decided and applied, in the order it happened, worded from the log. */
const record = computed(() => {
  const lines: { seq: number, text: string }[] = []
  const proposals = new Map<string, string>()
  for (const event of events.value) {
    if (event.kind === 'proposal.made') proposals.set(event.data.proposalId, words.actionText(event.data.action))
    else if (event.kind === 'proposal.approved') lines.push({ seq: event.seq, text: t('lb06.approval.approved', { action: proposals.get(event.data.proposalId) ?? event.data.proposalId }) })
    else if (event.kind === 'proposal.rejected') lines.push({ seq: event.seq, text: t('lb06.approval.rejected', { action: proposals.get(event.data.proposalId) ?? event.data.proposalId }) })
    else if (event.kind === 'remediation.applied') lines.push({ seq: event.seq, text: t('lb06.approval.applied', { minute: event.minute, action: words.actionText(event.data.action) }) })
  }
  return lines
})
</script>

<template>
  <section
    v-if="pending || record.length > 0"
    id="lb06-approval"
    class="lb6-panel card"
    :class="{ waiting: pending }"
    :aria-label="t('lb06.approval.title')"
    data-testid="approval"
  >
    <template v-if="pending">
      <h3>{{ t('lb06.approval.title') }}</h3>
      <p class="proposal">
        <LbIcon
          name="shield"
          :size="20"
          tone="mono"
        />
        <span data-testid="approval-action">{{ t('lb06.approval.proposes', { action }) }}</span>
      </p>
      <p data-testid="approval-why">
        {{ t('lb06.approval.why', { rationale: pending.rationale }) }}
      </p>
      <div class="blast">
        <h4>{{ t('lb06.approval.blast') }}</h4>
        <p data-testid="approval-blast">
          {{ words.blastText(pending.action) }}
        </p>
      </div>
      <p
        v-if="!brief"
        class="lb6-hint lb6-mono"
      >
        {{ t('lb06.approval.hypothesis', { id: pending.hypothesisId }) }}
      </p>
      <p class="lb6-hint">
        {{ runMode === 'live' ? t('lb06.approval.help') : t('lb06.approval.replayNone') }}
      </p>
      <div
        v-if="runMode === 'live'"
        class="lb6-row"
      >
        <button
          type="button"
          class="lb6-button lb6-button--primary"
          :disabled="busy !== 'idle'"
          :aria-label="t('lb06.approval.approveLabel', { action })"
          data-testid="approve"
          @click="store.decide('approve')"
        >
          {{ t('lb06.approval.approve') }}
        </button>
        <button
          type="button"
          class="lb6-button"
          :disabled="busy !== 'idle'"
          :aria-label="t('lb06.approval.rejectLabel', { action })"
          data-testid="reject"
          @click="store.decide('reject')"
        >
          {{ t('lb06.approval.reject') }}
        </button>
        <span
          v-if="busy === 'deciding'"
          class="lb6-hint"
          role="status"
        >{{ t('lb06.approval.working') }}</span>
      </div>
      <ProblemNotice
        v-if="decisionProblem"
        :problem="decisionProblem"
      />
    </template>
    <ul
      v-if="record.length > 0"
      class="record"
      data-testid="approval-record"
    >
      <li
        v-for="line in record"
        :key="line.seq"
      >
        {{ line.text }}
      </li>
    </ul>
  </section>
</template>

<style scoped>
.card {
  gap: 10px;
}
/* The proposal that waits is framed heavily, so it cannot be missed whether or not colour is seen. */
.waiting {
  border: 2px solid var(--lb-ink);
}
.proposal {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 15px;
  font-weight: 700;
}
.blast h4 {
  margin: 0 0 2px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}
.record {
  display: grid;
  gap: 4px;
  padding: 0 0 0 18px;
  margin: 0;
  font-size: 13.5px;
}
</style>
