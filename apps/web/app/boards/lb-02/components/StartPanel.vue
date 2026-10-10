<script setup lang="ts">
// <StartPanel>: where a visitor starts a conversation. It opens on the curated samples: a sample with
// a recording replays for free, and one without says so and offers the live run, which uses one of the
// day's conversations. The visitor reads what the sample says, message by message, and what other
// visitors do to the calendar in the recording, before choosing. The second way in is the visitor's own
// conversation, always live and the only path that reaches the Turnstile check. A conversation this
// tab left can be picked up again. This component only collects the choice and reports it; the board
// decides what to do with it.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ConversationSample, SampleWorldEvent } from '#shared/data/samples/lb02-types'

import { typeset } from '~/board-kit/format'
import type { PickerSample } from '~/board-kit/samples'

const props = defineProps<{
  samples: readonly PickerSample[]
  /** What each sample says and what other visitors do around it, by the sample's ID. */
  scripts: Readonly<Record<string, ConversationSample>>
  /** The IDs of the samples that have a recording, or undefined while that is not known yet. */
  recorded: readonly string[] | undefined
  /** True while a conversation is being opened. */
  busy: boolean
  /** Whether a live conversation is possible: the deployment has a back end and the day's conversations are not used up. */
  canRunLive: boolean
  /** True when a live run is off because the day's conversations are used up, so the hint can say that and not blame the site. */
  allowanceUsedUp: boolean
  /** The ID of the conversation this tab left, which can be picked up again. */
  remembered: string | undefined
  /** Writes an offering's name in the visitor's language. */
  titleOf: (key: string) => string
}>()

const emit = defineEmits<{
  replay: [sampleId: string]
  runSample: [sampleId: string]
  begin: []
  resume: []
  forget: []
}>()

const { t } = useI18n()

const heading = ref<HTMLElement>()
const source = ref<'sample' | 'own'>('sample')
const chosen = ref<string | undefined>(props.samples[0]?.id)

const sourceOptions = computed(() => [
  { value: 'sample' as const, label: t('lb02.start.samples') },
  { value: 'own' as const, label: t('lb02.start.own') },
])
const chosenSample = computed(() => props.samples.find(sample => sample.id === chosen.value))
const chosenScript = computed(() => (chosen.value === undefined ? undefined : props.scripts[chosen.value]))
const recordingKnown = computed(() => props.recorded !== undefined)
const hasRecording = computed(() => chosen.value !== undefined && props.recorded?.includes(chosen.value) === true)
// Why a live run is off, in the visitor's words: no conversation left today, or this copy of the site has no back end.
const liveHint = computed(() => (props.canRunLive ? undefined : props.allowanceUsedUp ? 'lb02.start.noAllowance' : 'lb02.start.noLive'))

/** Writes the day of a world event: tomorrow, the day after, or a number of days on. */
function dayWords(days: number): string {
  return t(`lb02.script.day.${days === 1 || days === 2 ? days : 'other'}`, { days })
}

/** Writes what another visitor does in the recording, such as "Another visitor books Coffee tasting tomorrow at 12:00, before message 1." */
function worldText(event: SampleWorldEvent): string {
  return t(`lb02.script.world.${event.otherVisitor}`, {
    offering: props.titleOf(event.offering),
    when: dayWords(event.day),
    time: event.time,
    number: event.beforeTurn,
  })
}

/** Puts the keyboard's focus on the panel's heading, for when the visitor comes back to it from a conversation. */
function focus(): void {
  heading.value?.focus()
}

defineExpose({ focus })

/** Reports the sample the visitor chose: replayed if it has a recording, live if it has not. */
function startSample(): void {
  if (chosen.value === undefined) return
  if (hasRecording.value) emit('replay', chosen.value)
  else emit('runSample', chosen.value)
}
</script>

<template>
  <section
    class="start"
    :aria-label="t('lb02.start.title')"
    data-testid="start"
  >
    <h2
      ref="heading"
      class="lb-label"
      tabindex="-1"
    >
      {{ t('lb02.start.title') }}
    </h2>

    <div
      v-if="remembered"
      class="resume"
      data-testid="resume"
    >
      <p class="resume-title">
        {{ t('lb02.start.resumeTitle') }}
      </p>
      <p class="hint">
        {{ t('lb02.start.resumeText') }}
      </p>
      <div class="buttons">
        <button
          type="button"
          class="button button--primary"
          :disabled="busy || !canRunLive"
          data-testid="resume-conversation"
          @click="emit('resume')"
        >
          {{ t('lb02.start.resume') }}
        </button>
        <button
          type="button"
          class="button"
          @click="emit('forget')"
        >
          {{ t('lb02.start.forget') }}
        </button>
      </div>
    </div>

    <LbSegmented
      v-model="source"
      class="switch"
      :options="sourceOptions"
      :label="t('lb02.start.modeLabel')"
    />

    <div
      v-if="source === 'sample'"
      class="pane"
    >
      <BoardSamplePicker
        v-model="chosen"
        :samples="samples"
        :recorded="recorded"
        :legend="t('lb02.start.samplesLegend')"
      />
      <figure
        v-if="chosenScript"
        class="preview"
        data-testid="sample-preview"
      >
        <figcaption class="lb-label">
          {{ t('lb02.start.visitorSays') }}
        </figcaption>
        <ol class="messages">
          <li
            v-for="(turn, index) in chosenScript.turns"
            :key="index"
          >
            <span class="meta">
              {{ t('lb02.start.messageNumber', { number: index + 1 }) }}
              <template v-if="turn.waitMinutes > 0"> &middot; {{ t('lb02.start.waitsBefore', { minutes: turn.waitMinutes }) }}</template>
            </span>
            <blockquote :lang="chosenScript.language">
              {{ typeset(turn.say, chosenScript.language) }}
            </blockquote>
          </li>
        </ol>
        <p
          v-if="chosenSample"
          class="shows"
        >
          {{ chosenSample.note }}
        </p>
        <template v-if="chosenScript.world.length > 0">
          <p class="lb-label">
            {{ t('lb02.start.worldTitle') }}
          </p>
          <ul class="world">
            <li
              v-for="event in chosenScript.world"
              :key="`${event.beforeTurn}-${event.offering}-${event.time}`"
            >
              {{ worldText(event) }}
            </li>
          </ul>
          <p class="hint">
            {{ t('lb02.script.secondTab') }}
          </p>
        </template>
      </figure>
      <p
        v-if="recordingKnown && !hasRecording"
        class="hint"
        data-testid="no-recording"
      >
        {{ t('lb02.start.noRecording') }} {{ t('lb02.start.liveCost') }}
      </p>
      <div class="buttons">
        <button
          type="button"
          class="button button--primary"
          :disabled="chosen === undefined || !recordingKnown || (!hasRecording && (busy || !canRunLive))"
          data-testid="start-sample"
          @click="startSample"
        >
          {{ hasRecording ? t('lb02.start.replay') : busy ? t('lb02.start.starting') : t('lb02.start.runSampleLive') }}
        </button>
        <button
          v-if="hasRecording && canRunLive"
          type="button"
          class="button"
          :disabled="busy"
          data-testid="run-sample-live"
          @click="chosen && emit('runSample', chosen)"
        >
          {{ t('lb02.start.runInstead') }}
        </button>
      </div>
      <p
        v-if="liveHint"
        class="hint"
        data-testid="live-hint"
      >
        {{ t(liveHint) }}
      </p>
    </div>

    <div
      v-else
      class="pane"
    >
      <p class="intro">
        {{ t('lb02.start.ownIntro') }}
      </p>
      <div class="buttons">
        <button
          type="button"
          class="button button--primary"
          :disabled="busy || !canRunLive"
          data-testid="begin"
          @click="emit('begin')"
        >
          {{ busy ? t('lb02.start.starting') : t('lb02.start.begin') }}
        </button>
      </div>
      <p
        v-if="liveHint"
        class="hint"
        data-testid="live-hint"
      >
        {{ t(liveHint) }}
      </p>
    </div>

    <p class="hint privacy">
      {{ t('lb02.start.privacy') }}
    </p>
  </section>
</template>

<style scoped>
.start {
  display: grid;
  gap: 12px;
  padding: 16px;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.switch {
  justify-self: start;
}

.pane {
  display: grid;
  gap: 12px;
}

.preview {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  margin: 0;
  background: var(--lb-shade);
  border: 1px solid var(--lb-rule);
}

.messages,
.world {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.world {
  gap: 4px;
  font-size: 13.5px;
}

.messages li {
  display: grid;
  gap: 2px;
}

.meta {
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  color: var(--lb-graphite);
}

blockquote {
  padding-left: 10px;
  margin: 0;
  font-size: 14px;
  border-left: 3px solid var(--lb-ink);
}

.shows,
.hint,
.intro {
  max-width: 68ch;
  font-size: 13.5px;
  color: var(--lb-graphite);
}

.intro {
  font-size: 14.5px;
  color: var(--lb-ink);
}

.resume {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-signal);
}

.resume-title {
  font-weight: 700;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.button {
  padding: 9px 16px;
  font: 600 14px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
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
