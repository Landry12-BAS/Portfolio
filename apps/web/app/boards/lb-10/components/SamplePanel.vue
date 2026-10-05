<script setup lang="ts">
// <SamplePanel>: "Start from a prepared edit". The visitor picks one of the curated starting points (a target with a
// prepared edit of its production prompt) and sees what the edit changes, as text, and the providers it runs on. They
// can replay its recording, which is free, run it live, which uses their one run of the day and needs the quick check
// that they are a person, or put it in the editor to change it further. A sample with no recording says so.
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { LB10_SAMPLES } from '#shared/data/samples/lb10'
import type { Lb10SampleId } from '#shared/data/samples/lb10'
import { useLb10Words } from '../words'

const props = defineProps<{
  /** The IDs of the samples that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  /** Whether a run is being started or followed, so nothing new can start. */
  busy: boolean
  /** Whether this copy of the site can run evals live and the visitor has a run left. */
  canRunLive: boolean
}>()

const emit = defineEmits<{
  replay: [id: Lb10SampleId]
  live: [id: Lb10SampleId]
  edit: [id: Lb10SampleId]
}>()

const { t } = useI18n()
const words = useLb10Words()
const id = useId()

const selected = ref<Lb10SampleId>(LB10_SAMPLES[0].id)
const sample = computed(() => LB10_SAMPLES.find(item => item.id === selected.value) ?? LB10_SAMPLES[0])
const hasRecording = computed(() => props.recorded?.includes(selected.value) === true)
const providerNames = computed(() => sample.value.providers.map(provider => words.providerName(provider)).join(', '))
</script>

<template>
  <section
    class="lb10-section"
    :aria-labelledby="`${id}-title`"
    data-testid="sample-panel"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb10.samples.title') }}
    </h2>
    <fieldset class="choices">
      <legend class="lb10-label">
        {{ t('lb10.samples.legend') }}
      </legend>
      <label
        v-for="item in LB10_SAMPLES"
        :key="item.id"
        class="choice"
        :data-testid="`sample-${item.id}`"
      >
        <input
          v-model="selected"
          type="radio"
          :name="`${id}-sample`"
          :value="item.id"
        >
        <span class="text">
          <strong>{{ t(`lb10.samples.items.${item.id}.title`) }}</strong>
          <span class="lb10-hint">{{ t(`lb10.samples.items.${item.id}.note`) }}</span>
        </span>
      </label>
    </fieldset>
    <div
      class="chosen"
      data-testid="sample-details"
    >
      <p class="lb10-label">
        {{ t('lb10.samples.edit') }}
      </p>
      <template v-if="sample.edit.kind === 'insert'">
        <p>{{ t('lb10.samples.insert') }}</p>
        <blockquote
          class="lb10-quote"
          lang="en"
          data-testid="sample-added"
        >
          {{ sample.edit.line }}
        </blockquote>
        <p>{{ t('lb10.samples.insertAfter') }}</p>
        <blockquote
          class="lb10-quote"
          lang="en"
        >
          {{ sample.edit.after }}
        </blockquote>
      </template>
      <template v-else-if="sample.edit.kind === 'replace'">
        <p>{{ t('lb10.samples.replace') }}</p>
        <blockquote
          class="lb10-quote"
          lang="en"
          data-testid="sample-removed"
        >
          {{ sample.edit.text }}
        </blockquote>
        <p>{{ t('lb10.samples.replaceWith') }}</p>
        <blockquote
          class="lb10-quote"
          lang="en"
          data-testid="sample-added"
        >
          {{ sample.edit.with }}
        </blockquote>
      </template>
      <template v-else-if="sample.edit.kind === 'remove-lines'">
        <p>{{ t('lb10.samples.remove') }}</p>
        <blockquote
          v-for="(line, index) in sample.edit.lines"
          :key="index"
          class="lb10-quote lb10-focusable quote--long"
          lang="en"
          tabindex="0"
          data-testid="sample-removed"
        >
          {{ line }}
        </blockquote>
      </template>
      <p
        v-else
        data-testid="sample-unchanged"
      >
        {{ t('lb10.samples.unchanged') }}
      </p>
      <p class="runs-on">
        <span class="lb10-label">{{ t('lb10.samples.runsOn') }}</span>
        <span>{{ providerNames }}</span>
      </p>
    </div>
    <p
      v-if="recorded !== undefined && !hasRecording"
      class="lb10-hint"
      data-testid="no-recording"
    >
      {{ t('lb10.samples.noRecording') }}
    </p>
    <div class="lb10-row">
      <button
        type="button"
        class="lb10-button"
        :disabled="busy || !hasRecording"
        data-testid="replay-sample"
        @click="emit('replay', selected)"
      >
        {{ t('lb10.samples.replay') }}
      </button>
      <button
        type="button"
        class="lb10-button lb10-button--primary"
        :disabled="busy || !canRunLive"
        data-testid="live-sample"
        @click="emit('live', selected)"
      >
        {{ t('lb10.samples.live') }}
      </button>
      <button
        type="button"
        class="lb10-button lb10-button--quiet"
        :disabled="busy"
        data-testid="edit-sample"
        @click="emit('edit', selected)"
      >
        {{ t('lb10.samples.openInEditor') }}
      </button>
    </div>
    <p class="lb10-hint">
      {{ t('lb10.samples.liveCost') }}
    </p>
  </section>
</template>

<style scoped>
.choices {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr));
  gap: 8px;
  padding: 0;
  margin: 0;
  border: 0;
}
.choices legend {
  margin-bottom: 6px;
}
.choice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  cursor: pointer;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
  border-radius: 4px;
}
.choice:has(input:checked) {
  border-color: var(--lb-ink);
}
.choice:has(input:focus-visible) {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}
.choice input {
  flex: none;
  margin-top: 3px;
}
.text {
  display: grid;
  gap: 2px;
  justify-items: start;
  min-width: 0;
}
.chosen {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 12px 14px;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}
.quote--long {
  max-height: 9rem;
  overflow: auto;
  font-family: var(--lb-font-mono);
  font-size: 12px;
}
.runs-on {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}
</style>
