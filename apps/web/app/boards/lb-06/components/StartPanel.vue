<script setup lang="ts">
// <StartPanel>: "Break the shop". The visitor picks one of the four curated incidents (each is a fault
// with a fixed seed, so it plays out the same way every time and its agents' work can be cached) and
// either replays its recording, which is free, or runs it live, which uses the one incident a visitor
// gets each day and needs the quick check that they are a person. Below, a fold-out makes an incident
// of their own: the same four faults with a seed of their choice and two labels they may write (the
// bad deploy's version and the name of a feature flag). Those two texts are the one thing a visitor can
// say to the system, so the panel checks them against the same pattern the service does, and the
// service screens them for instructions before any agent reads anything.
import { LB06_PARAM_PATTERN } from '@lb/contracts'
import type { Lb06Fault, Lb06StartIncidentRequest } from '@lb/contracts'
import { LB06_SAMPLES } from '#shared/data/samples/lb06'
import type { Lb06SampleId } from '#shared/data/samples/lb06'
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  /** The IDs of the samples that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  /** Whether an incident is being started or followed, so nothing new can start. */
  busy: boolean
  /** Whether this copy of the site can run an incident live and the visitor has one left. */
  canRunLive: boolean
  /** Whether the visitor's incident for today is used. */
  allowanceUsedUp: boolean
  /** Whether this copy of the site has no back end at all. */
  unavailable: boolean
}>()

const emit = defineEmits<{
  replay: [id: Lb06SampleId]
  live: [id: Lb06SampleId]
  own: [request: Lb06StartIncidentRequest]
}>()

/** The largest seed the service accepts. */
const MAX_SEED = 2_147_483_647

const { t } = useI18n()
const id = useId()

const selected = ref<Lb06SampleId>(LB06_SAMPLES[0].id)
const fault = ref<Lb06Fault>('bad_deploy')
const seed = ref('')
const version = ref('')
const flag = ref('')

const hasRecording = computed(() => props.recorded?.includes(selected.value) === true)
const seedValid = computed(() => seed.value.trim() === '' || (/^\d{1,10}$/.test(seed.value.trim()) && Number(seed.value.trim()) <= MAX_SEED))
const versionValid = computed(() => version.value === '' || LB06_PARAM_PATTERN.test(version.value))
const flagValid = computed(() => flag.value === '' || LB06_PARAM_PATTERN.test(flag.value))
const ownValid = computed(() => seedValid.value && versionValid.value && flagValid.value)

/** The request for the incident the visitor describes below. */
function ownRequest(): Lb06StartIncidentRequest {
  const params = { ...(version.value === '' ? {} : { version: version.value }), ...(flag.value === '' ? {} : { flag: flag.value }) }
  return {
    from: 'custom',
    fault: fault.value,
    ...(seed.value.trim() === '' ? {} : { seed: Number(seed.value.trim()) }),
    ...(Object.keys(params).length === 0 ? {} : { params }),
  }
}

/** Starts the incident the visitor describes, if it is valid. */
function startOwn(): void {
  if (ownValid.value && props.canRunLive && !props.busy) emit('own', ownRequest())
}
</script>

<template>
  <section
    class="lb6-section"
    :aria-label="t('lb06.start.title')"
    data-testid="start-panel"
  >
    <h2>{{ t('lb06.start.title') }}</h2>
    <fieldset class="faults">
      <legend>{{ t('lb06.start.legend') }}</legend>
      <label
        v-for="sample in LB06_SAMPLES"
        :key="sample.id"
        class="fault"
        :data-testid="`sample-${sample.id}`"
      >
        <input
          v-model="selected"
          type="radio"
          name="lb06-sample"
          :value="sample.id"
        >
        <span class="text">
          <strong>{{ t(`lb06.samples.${sample.id}.title`) }}</strong>
          <span class="lb6-hint">{{ t(`lb06.samples.${sample.id}.note`) }}</span>
          <span class="lb6-chip">{{ t(`lb06.faults.${sample.fault}.title`) }}</span>
        </span>
      </label>
    </fieldset>
    <p
      v-if="recorded !== undefined && !hasRecording"
      class="lb6-hint"
      data-testid="no-recording"
    >
      {{ t('lb06.start.noRecording') }}
    </p>
    <div class="lb6-row">
      <button
        type="button"
        class="lb6-button"
        :disabled="busy || !hasRecording"
        data-testid="replay-sample"
        @click="emit('replay', selected)"
      >
        {{ t('lb06.start.replay') }}
      </button>
      <button
        type="button"
        class="lb6-button lb6-button--primary"
        :disabled="busy || !canRunLive"
        data-testid="live-sample"
        @click="emit('live', selected)"
      >
        {{ t('lb06.start.live') }}
      </button>
    </div>
    <p class="lb6-hint">
      {{ t('lb06.start.liveCost') }}
    </p>
    <p
      v-if="unavailable"
      class="lb6-hint"
      data-testid="no-live"
    >
      {{ t('lb06.start.noLive') }}
    </p>
    <p
      v-else-if="allowanceUsedUp"
      class="lb6-hint"
      data-testid="allowance-used"
    >
      {{ t('lb06.start.allowanceUsed') }}
    </p>
    <details
      class="own"
      data-testid="own-details"
    >
      <summary>{{ t('lb06.start.ownTitle') }}</summary>
      <form
        class="form"
        novalidate
        @submit.prevent="startOwn"
      >
        <p class="lb6-hint">
          {{ t('lb06.start.ownHint') }}
        </p>
        <div class="lb6-field">
          <label :for="`${id}-fault`">{{ t('lb06.start.faultLabel') }}</label>
          <select
            :id="`${id}-fault`"
            v-model="fault"
            class="lb6-control"
            data-testid="own-fault"
          >
            <option
              v-for="sample in LB06_SAMPLES"
              :key="sample.fault"
              :value="sample.fault"
            >
              {{ t(`lb06.faults.${sample.fault}.title`) }}
            </option>
          </select>
        </div>
        <div class="lb6-field">
          <label :for="`${id}-seed`">{{ t('lb06.start.seedLabel') }}</label>
          <input
            :id="`${id}-seed`"
            v-model="seed"
            class="lb6-control"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            maxlength="10"
            :aria-invalid="!seedValid"
            :aria-describedby="`${id}-seed-hint`"
            data-testid="own-seed"
          >
          <p
            :id="`${id}-seed-hint`"
            class="lb6-hint"
          >
            {{ seedValid ? t('lb06.start.seedHint') : t('lb06.start.invalidSeed') }}
          </p>
        </div>
        <div class="lb6-field">
          <label :for="`${id}-version`">{{ t('lb06.start.versionLabel') }}</label>
          <input
            :id="`${id}-version`"
            v-model="version"
            class="lb6-control"
            type="text"
            autocomplete="off"
            maxlength="40"
            :aria-invalid="!versionValid"
            :aria-describedby="`${id}-version-hint`"
            data-testid="own-version"
          >
          <p
            :id="`${id}-version-hint`"
            class="lb6-hint"
          >
            {{ versionValid ? t('lb06.start.paramHint') : t('lb06.start.invalidText') }}
          </p>
        </div>
        <div class="lb6-field">
          <label :for="`${id}-flag`">{{ t('lb06.start.flagLabel') }}</label>
          <input
            :id="`${id}-flag`"
            v-model="flag"
            class="lb6-control"
            type="text"
            autocomplete="off"
            maxlength="40"
            :aria-invalid="!flagValid"
            :aria-describedby="`${id}-flag-hint`"
            data-testid="own-flag"
          >
          <p
            :id="`${id}-flag-hint`"
            class="lb6-hint"
          >
            {{ flagValid ? t('lb06.start.paramHint') : t('lb06.start.invalidText') }}
          </p>
        </div>
        <div class="lb6-row">
          <button
            type="submit"
            class="lb6-button lb6-button--primary"
            :disabled="busy || !canRunLive || !ownValid"
            data-testid="own-submit"
          >
            {{ t('lb06.start.startOwn') }}
          </button>
        </div>
      </form>
    </details>
  </section>
</template>

<style scoped>
.faults {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  border: 0;
}
.faults legend {
  margin-bottom: 6px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}
.fault {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  cursor: pointer;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
  border-radius: 4px;
}
.fault:has(input:checked) {
  border-color: var(--lb-ink);
}
.fault:has(input:focus-visible) {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}
.text {
  display: grid;
  gap: 2px;
  justify-items: start;
}
.own {
  padding-top: 4px;
}
.own summary {
  font-weight: 700;
  cursor: pointer;
}
.own summary:focus-visible {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}
.form {
  display: grid;
  gap: 12px;
  max-width: 420px;
  padding-top: 10px;
}
</style>
