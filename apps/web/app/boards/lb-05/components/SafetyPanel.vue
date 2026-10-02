<script setup lang="ts">
// <SafetyPanel>: the datasheet's "then try to make it delete data". A visitor picks one of the attacks
// from the adversarial set (or writes their own), a model is asked to carry it out, and whatever SQL it
// writes meets the six layers; the panel says plainly what each layer is and, once an attack has been
// run, which layer stopped it, read from the answer's own fields. An attack with a recording replays it
// for free; one without says so and offers the live run, which asks a real model and uses one of the
// day's questions. This component collects the choice and reports it, and the board runs it.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { AttackItem } from '../attacks'
import type { Limits } from '../schemas'
import type { LayerVerdict } from '../verdict'

import LayerLadder from './LayerLadder.vue'
import QuestionBox from './QuestionBox.vue'

const props = defineProps<{
  attacks: readonly AttackItem[]
  /** The IDs of the attacks that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  busy: boolean
  canRunLive: boolean
  allowanceUsedUp: boolean
  limits: Limits
  /** What each layer did to the last attack, or undefined before one has been run. */
  verdicts: readonly LayerVerdict[] | undefined
  /** True when the last question never produced a query. */
  noQuery: boolean
  /** The Brief reading leaves out the longer explanations. */
  brief: boolean
}>()

const emit = defineEmits<{
  replay: [attackId: string]
  run: [attackId: string]
  ask: [question: string]
}>()

const { t } = useI18n()

const chosen = ref<string | undefined>(props.attacks[0]?.id)
const chosenAttack = computed(() => props.attacks.find(attack => attack.id === chosen.value))
const hasRecording = computed(() => chosen.value !== undefined && props.recorded?.includes(chosen.value) === true)
const recordingKnown = computed(() => props.recorded !== undefined)
const liveHint = computed(() => (props.canRunLive ? undefined : props.allowanceUsedUp ? 'lb05.ask.noAllowance' : 'lb05.ask.noLive'))

/** Reports the attack the visitor chose: replayed if it has a recording, live if it has not. */
function start(): void {
  if (chosen.value === undefined) return
  if (hasRecording.value) emit('replay', chosen.value)
  else emit('run', chosen.value)
}
</script>

<template>
  <section
    class="safety"
    :aria-label="t('lb05.attack.title')"
    data-testid="safety"
  >
    <h2 class="lb-label">
      {{ t('lb05.attack.title') }}
    </h2>
    <p class="intro">
      {{ t('lb05.attack.intro') }}
    </p>

    <BoardSamplePicker
      v-model="chosen"
      :samples="attacks"
      :recorded="recorded"
      :legend="t('lb05.attack.samplesLegend')"
    />
    <figure
      v-if="chosenAttack"
      class="preview"
    >
      <figcaption class="lb-label">
        {{ t('lb05.attack.questionSent') }}
      </figcaption>
      <blockquote
        lang="en"
        data-testid="attack-question"
      >
        {{ chosenAttack.excerpt }}
      </blockquote>
      <p class="shows">
        {{ chosenAttack.note }}
      </p>
      <p
        class="expect"
        data-testid="attack-expected"
      >
        <template v-if="chosenAttack.stoppedBy === 'row_limit'">
          {{ t('lb05.attack.heldByCap') }}
        </template>
        <template v-else>
          {{ t('lb05.attack.expected') }}
          <strong>{{ t(`lb05.layers.items.${chosenAttack.stoppedBy}.name`) }}</strong>:
          {{ t(`lb05.rules.${chosenAttack.rule}`) }}
        </template>
      </p>
    </figure>
    <p
      v-if="recordingKnown && !hasRecording"
      class="hint"
      data-testid="no-recording"
    >
      {{ t('lb05.ask.noRecording') }} {{ t('lb05.ask.liveCost') }}
    </p>
    <div class="buttons">
      <button
        type="button"
        class="button button--primary"
        :disabled="chosen === undefined || !recordingKnown || (!hasRecording && (busy || !canRunLive))"
        data-testid="start-attack"
        @click="start"
      >
        {{ hasRecording ? t('lb05.attack.replay') : t('lb05.attack.runLive') }}
      </button>
      <button
        v-if="hasRecording && canRunLive"
        type="button"
        class="button"
        :disabled="busy"
        data-testid="run-attack-live"
        @click="chosen && emit('run', chosen)"
      >
        {{ t('lb05.attack.runInstead') }}
      </button>
    </div>
    <p
      v-if="liveHint"
      class="hint"
      data-testid="live-hint"
    >
      {{ t(liveHint) }}
    </p>
    <p
      v-if="!brief"
      class="hint"
    >
      {{ t('lb05.attack.liveNote') }}
    </p>

    <QuestionBox
      id-base="lb05-attack"
      :label="t('lb05.attack.ownLabel')"
      :hint="t('lb05.attack.ownHint')"
      :submit-label="t('lb05.attack.ownSubmit')"
      :busy="busy"
      :disabled="!canRunLive"
      @submit="emit('ask', $event)"
    />

    <LayerLadder
      :verdicts="verdicts"
      :limits="limits"
      :no-query="noQuery"
    />

    <p
      v-if="!brief"
      class="hint"
      data-testid="six-checks"
    >
      {{ t('lb05.attack.sixChecks') }}
    </p>
    <p class="hint">
      {{ t('lb05.attack.hiddenColumns') }}
    </p>
  </section>
</template>

<style scoped>
.safety {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.intro {
  max-width: 70ch;
  font-size: 14.5px;
}

.preview {
  display: grid;
  gap: 4px;
  margin: 0;
}

.shows {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.expect {
  font-size: 13px;
}

blockquote {
  padding: 8px 12px;
  margin: 0;
  font-style: italic;
  background: var(--lb-shade);
  border-left: 3px solid var(--lb-rule);
}

.hint {
  max-width: 70ch;
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.button {
  padding: 9px 18px;
  font: 600 13.5px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.button:hover:not(:disabled) {
  background: var(--lb-shade);
}

.button--primary {
  color: var(--lb-sheet);
  background: var(--lb-ink);
}

.button--primary:hover:not(:disabled) {
  background: var(--lb-ink-hover);
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
