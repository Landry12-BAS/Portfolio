<script setup lang="ts">
// <IncidentBar>: where the incident stands, in one strip: its state in words with an icon (never by
// colour alone), the simulated clock, the model calls it has used of the step cap, the proposals it
// has made, how the board is following it (the live feed, or polling when the feed is out of reach),
// and what the injection screen said of the visitor's own text. It holds the two buttons that act on
// the whole incident: pausing the charts, which only freezes the drawing, and ending the incident early.
import { LB06_LIMITS } from '@lb/contracts'
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLb06Store } from '../store'
import { useLb06Words } from '../words'

defineProps<{
  /** The Brief reading leaves out the cap's explanation and the technical facts. */
  brief: boolean
}>()

const { t, te } = useI18n()
const words = useLb06Words()
const store = useLb06Store()
const { incident, state, minute, modelCalls, feed, feedEnd, paused, runMode, canAbort, busy } = storeToRefs(store)

const icon = computed(() => {
  switch (state.value) {
    case 'closed': return 'success'
    case 'aborted':
    case 'failed':
      return 'error'
    case 'awaiting_approval': return 'warning'
    default: return 'live'
  }
})
const proposals = computed(() => store.events.filter(event => event.kind === 'proposal.made').length)
const feedNote = computed(() => {
  const key = `lb06.bar.feedEnd.${feedEnd.value ?? ''}`
  return feed.value === 'polling' && feedEnd.value !== undefined && te(key) ? t(key) : undefined
})
</script>

<template>
  <section
    v-if="incident && state"
    class="lb6-panel bar"
    :aria-label="t('lb06.bar.label')"
    data-testid="incident-bar"
  >
    <p
      class="state"
      role="status"
      data-testid="incident-state"
      :data-state="state"
    >
      <LbIcon
        :name="icon"
        :size="20"
        tone="mono"
      />
      <span>{{ words.stateWord(state) }}</span>
    </p>
    <p
      v-if="incident.endReason"
      class="lb6-hint"
      data-testid="end-reason"
    >
      {{ words.endReasonWord(incident.endReason) }}
    </p>
    <dl class="facts">
      <div>
        <dt>{{ t('lb06.bar.clock') }}</dt>
        <dd data-testid="incident-minute">
          {{ t('lb06.bar.minute', { minute }) }}
        </dd>
      </div>
      <div>
        <dt>{{ t('lb06.bar.calls') }}</dt>
        <dd data-testid="model-calls">
          {{ t('lb06.bar.callsValue', { used: modelCalls, cap: LB06_LIMITS.stepCap }) }}
        </dd>
      </div>
      <div>
        <dt>{{ t('lb06.bar.proposals') }}</dt>
        <dd data-testid="proposals">
          {{ t('lb06.bar.proposalsValue', { used: proposals, cap: LB06_LIMITS.maxProposals }) }}
        </dd>
      </div>
      <div v-if="runMode === 'live'">
        <dt>{{ t('lb06.bar.feed') }}</dt>
        <dd data-testid="feed">
          {{ t(`lb06.bar.feedValues.${feed}`) }}
        </dd>
      </div>
      <div>
        <dt>{{ t('lb06.bar.guard') }}</dt>
        <dd data-testid="guard">
          {{ t(`lb06.bar.guardValues.${incident.guard}`) }}
        </dd>
      </div>
      <div v-if="!brief">
        <dt>{{ t('lb06.bar.state') }}</dt>
        <dd class="lb6-mono">
          {{ incident.origin }}{{ incident.sampleId ? `, ${incident.sampleId}` : '' }}, seed {{ incident.scenario.seed }}
        </dd>
      </div>
    </dl>
    <p
      v-if="!brief"
      class="lb6-hint"
    >
      {{ t('lb06.bar.callsNote', { cap: LB06_LIMITS.stepCap }) }}
    </p>
    <p
      v-if="incident.cached"
      class="lb6-hint"
      data-testid="cached"
    >
      {{ t('lb06.bar.cached') }}
    </p>
    <p
      v-if="feedNote"
      class="lb6-hint"
      data-testid="feed-fallback"
    >
      {{ feedNote }}
    </p>
    <p
      v-if="runMode === 'replay'"
      class="lb6-hint"
      data-testid="replaying-note"
    >
      {{ t('lb06.bar.replaying') }}
    </p>
    <div class="lb6-row">
      <button
        type="button"
        class="lb6-button"
        :aria-pressed="paused"
        data-testid="pause"
        @click="paused ? store.resume() : store.pause()"
      >
        <LbIcon
          :name="paused ? 'play' : 'pause'"
          :size="16"
          tone="mono"
        />
        {{ paused ? t('lb06.bar.resume') : t('lb06.bar.pause') }}
      </button>
      <button
        v-if="runMode === 'live'"
        type="button"
        class="lb6-button lb6-button--quiet"
        :disabled="!canAbort"
        data-testid="abort"
        @click="store.abort()"
      >
        {{ busy === 'aborting' ? t('lb06.bar.aborting') : t('lb06.bar.abort') }}
      </button>
    </div>
    <p class="lb6-hint">
      {{ t('lb06.bar.pauseHint') }}
      <template v-if="runMode === 'live'">
        {{ t('lb06.bar.abortHint') }}
      </template>
    </p>
  </section>
</template>

<style scoped>
.bar {
  gap: 10px;
}
.state {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 16px;
  font-weight: 700;
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px 16px;
  margin: 0;
}
.facts dt {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}
.facts dd {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
</style>
