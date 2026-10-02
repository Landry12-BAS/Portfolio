<script setup lang="ts">
// <DescribeComposer>: where a visitor gets a workflow. It opens on the curated samples: a sample with
// a recording replays it for free, and one without says so and offers to open it live, which costs
// no model call (a sample's workflow is written by hand) and only needs the check that the visitor
// is a person. The second way in is the visitor's own words, which a model turns into a workflow:
// that is the only path that spends the free model quota, and the one that always needs the check.
// This component only collects the choice and reports it; the board decides what to do with it.
import { GRAPH_LIMITS } from '@lb/contracts'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { typeset } from '~/board-kit/format'
import type { PickerSample } from '~/board-kit/samples'

/** The shortest description the service accepts. */
const MIN_LENGTH = 10

const props = defineProps<{
  samples: readonly PickerSample[]
  /** The IDs of the samples that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  /** True while a workflow is being opened or described. */
  busy: boolean
  /** Whether a sample can be opened live: the deployment has a back end. */
  canOpenLive: boolean
  /** Whether a process can be described: the deployment has a back end and the day's descriptions are not used up. */
  canDescribe: boolean
  /** True when describing is off because the day's descriptions are used up, so the hint can say that and not blame the site. */
  allowanceUsedUp: boolean
  /** The full text of each sample, by ID, so the visitor can read the process before choosing. */
  bodies: Readonly<Record<string, string>>
  /** Descriptions left today, or undefined while they are being counted. */
  descriptionsLeft: number | undefined
}>()

const emit = defineEmits<{
  replay: [sampleId: string]
  openLive: [sampleId: string]
  describe: [description: string]
}>()

const { t } = useI18n()

const source = ref<'sample' | 'own'>('sample')
const chosen = ref<string | undefined>(props.samples[0]?.id)
const text = ref('')

const sourceOptions = computed(() => [
  { value: 'sample' as const, label: t('lb08.describe.samples') },
  { value: 'own' as const, label: t('lb08.describe.own') },
])
const hasRecording = computed(() => chosen.value !== undefined && props.recorded?.includes(chosen.value) === true)
const recordingKnown = computed(() => props.recorded !== undefined)
const chosenSample = computed(() => props.samples.find(sample => sample.id === chosen.value))
const chosenBody = computed(() => (chosen.value === undefined ? '' : props.bodies[chosen.value] ?? ''))
const chosenLanguage = computed(() => chosenSample.value?.language ?? 'en')
const length = computed(() => text.value.trim().length)
const longEnough = computed(() => length.value >= MIN_LENGTH)
const canSubmit = computed(() => !props.busy && props.canDescribe && longEnough.value && text.value.length <= GRAPH_LIMITS.maxDescriptionLength)
// Why a button is off, in the visitor's words.
const sampleHint = computed(() => (props.canOpenLive ? undefined : 'lb08.describe.noLive'))
const ownHint = computed(() => (props.canDescribe ? undefined : props.allowanceUsedUp ? 'lb08.describe.noAllowance' : 'lb08.describe.noLive'))

/** Reports the sample the visitor chose: replayed if it has a recording, opened live if it has not. */
function startSample(): void {
  if (chosen.value === undefined) return
  if (hasRecording.value) emit('replay', chosen.value)
  else emit('openLive', chosen.value)
}

/** Reports the description the visitor wrote. */
function describeOwn(): void {
  if (canSubmit.value) emit('describe', text.value.trim())
}
</script>

<template>
  <section
    class="lb8-section"
    :aria-label="t('lb08.describe.title')"
  >
    <h2>{{ t('lb08.describe.title') }}</h2>
    <LbSegmented
      v-model="source"
      class="switch"
      :options="sourceOptions"
      :label="t('lb08.describe.modeLabel')"
    />

    <div
      v-if="source === 'sample'"
      class="pane"
    >
      <BoardSamplePicker
        v-model="chosen"
        :samples="samples"
        :recorded="recorded"
        :legend="t('lb08.describe.samplesLegend')"
      />
      <figure
        v-if="chosenBody"
        class="preview"
      >
        <figcaption class="lb-label">
          {{ t('lb08.describe.sampleWrites') }}
        </figcaption>
        <blockquote :lang="chosenLanguage">
          {{ typeset(chosenBody, chosenLanguage) }}
        </blockquote>
        <p
          v-if="chosenSample"
          class="lb8-hint"
        >
          {{ chosenSample.note }}
        </p>
      </figure>
      <p class="lb8-hint">
        {{ t('lb08.describe.handWritten') }}
      </p>
      <p
        v-if="recordingKnown && !hasRecording"
        class="lb8-hint"
        data-testid="no-recording"
      >
        {{ t('lb08.describe.noRecording') }} {{ t('lb08.describe.liveCost') }}
      </p>
      <div class="lb8-row">
        <button
          type="button"
          class="lb8-button lb8-button--primary"
          :disabled="chosen === undefined || !recordingKnown || (!hasRecording && (busy || !canOpenLive))"
          data-testid="start-sample"
          @click="startSample"
        >
          {{ hasRecording ? t('lb08.describe.replay') : t('lb08.describe.openLive') }}
        </button>
        <button
          v-if="hasRecording && canOpenLive"
          type="button"
          class="lb8-button"
          :disabled="busy"
          data-testid="open-sample-live"
          @click="chosen && emit('openLive', chosen)"
        >
          {{ t('lb08.describe.openInstead') }}
        </button>
      </div>
      <p
        v-if="sampleHint"
        class="lb8-hint"
        data-testid="live-hint"
      >
        {{ t(sampleHint) }}
      </p>
    </div>

    <form
      v-else
      class="pane"
      @submit.prevent="describeOwn"
    >
      <div class="lb8-field">
        <label for="lb08-description">{{ t('lb08.describe.ownLabel') }}</label>
        <textarea
          id="lb08-description"
          v-model="text"
          class="lb8-control"
          rows="4"
          :maxlength="GRAPH_LIMITS.maxDescriptionLength"
          aria-describedby="lb08-description-hint"
        />
        <p
          id="lb08-description-hint"
          class="lb8-hint"
        >
          {{ t('lb08.describe.ownHint') }}
          <span class="count lb8-nums">{{ t('lb08.describe.counter', { count: text.length, max: GRAPH_LIMITS.maxDescriptionLength }) }}</span>
          <span v-if="text.length > 0 && !longEnough"> {{ t('lb08.describe.tooShort', { min: MIN_LENGTH }) }}</span>
        </p>
      </div>
      <div class="lb8-row">
        <button
          type="submit"
          class="lb8-button lb8-button--primary"
          :disabled="!canSubmit"
          data-testid="describe"
        >
          {{ busy ? t('lb08.describe.describing') : t('lb08.describe.submit') }}
        </button>
      </div>
      <p
        v-if="busy"
        class="lb8-hint"
        role="status"
        data-testid="describing"
      >
        {{ t('lb08.describe.describingStatus') }}
      </p>
      <p
        v-if="ownHint"
        class="lb8-hint"
        data-testid="live-hint"
      >
        {{ t(ownHint) }}
      </p>
      <p class="lb8-hint">
        {{ t('lb08.describe.cost') }}
        <template v-if="descriptionsLeft !== undefined">
          {{ t('lb08.descriptionsLabel') }}: {{ descriptionsLeft }}.
        </template>
      </p>
    </form>

    <p class="lb8-hint">
      {{ t('lb08.describe.privacy') }}
    </p>
  </section>
</template>

<style scoped>
.switch {
  justify-self: start;
}

.pane {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.preview {
  display: grid;
  gap: 4px;
  margin: 0;
}

blockquote {
  padding: 8px 12px;
  margin: 0;
  font-style: italic;
  background: var(--lb-shade);
  border-left: 3px solid var(--lb-rule);
}

.count {
  margin-left: 8px;
  font-family: var(--lb-font-mono);
}
</style>
