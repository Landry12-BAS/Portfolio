<script setup lang="ts">
// <RecorderPanel>: the visitor's own recording, up to a minute, from the microphone or from a file on
// their device. Before anything is asked of the browser the panel says what will happen: the browser
// will ask for the microphone, the audio stays in this page until the visitor sends it, a recording is
// a minute at most, and the back end deletes the audio once it is transcribed. Pressing record asks for
// the microphone; while recording the panel counts down the seconds and draws the sound level (not for
// a visitor who prefers reduced motion). A file is checked here before it can be sent, as the service
// will check it again: one of the containers it takes, at most 3 MiB, and no longer than a minute when
// the browser can tell its length, so a file the service would refuse does not spend one of the day's
// recordings. Either way the visitor can listen back, send it, or discard it. One button records and
// stops, so the keyboard's focus stays on it, and goes back to it when a recording is discarded. A
// browser that cannot record, a microphone that was refused, and a microphone that could not be read
// each get their own words, and none of them is treated as the site failing.
import { LbIcon } from '@lb/icons'
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { durationOf, readRecording } from '../audio'
import type { Recording } from '../audio'
import { browserRecorderDeps, MicrophoneRecorder } from '../recorder'
import type { RecorderFailure, RecorderState } from '../recorder'
import { MAX_RECORDING_SECONDS, MAX_UPLOAD_BYTES } from '../schemas'
import AudioPlayer from './AudioPlayer.vue'

/** Why a chosen file cannot be sent. */
type FileProblem = 'too_big' | 'unreadable' | 'too_long'

/** The audio files the picker offers: the containers the service takes. */
const ACCEPTED_FILES = '.webm,.ogg,.oga,.opus,.m4a,.mp4,.wav,.mp3,audio/webm,audio/ogg,audio/mp4,audio/wav,audio/x-wav,audio/mpeg'
// A file a little over the minute is still a minute to a person; the service measures it from the decoded samples.
const LENGTH_SLACK_SECONDS = 0.5

const props = defineProps<{
  /** A meeting is being worked on: the recording can be made but not sent yet. */
  busy: boolean
  /** Whether a live run can be started at all. */
  canRunLive: boolean
  /** The back end is there but the visitor has no recording left today. */
  allowanceUsedUp: boolean
}>()

const emit = defineEmits<{ send: [recording: Recording, url: string] }>()

const { t } = useI18n()

const state = ref<RecorderState>('idle')
const failure = ref<RecorderFailure>()
const elapsed = ref(0)
const level = ref(0)
const recorded = ref<Recording>()
const url = ref<string>()
// The recording's container is not one the service takes: said here instead of after an upload.
const unreadable = ref(false)
// A file the visitor chose, by its name on their device (shown, never sent), and its length when the browser could tell it.
const chosenName = ref<string>()
const chosenSeconds = ref<number>()
const fileProblem = ref<FileProblem>()
const reading = ref(false)
// The picker itself: it shows the chosen file's name, as the words below it do, until the file is let go of.
const fileInput = ref<HTMLInputElement>()
const recordButton = ref<HTMLButtonElement>()
// The level meter is drawn only while it moves: a visitor who prefers reduced motion gets the countdown alone.
const showLevels = ref(false)

/** Whether the visitor's system asks for less motion, in which case the level meter is left out. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Lets go of the URL made for the recording, if the browser can. */
function forgetUrl(): void {
  if (url.value !== undefined && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url.value)
  url.value = undefined
}

/** Makes a URL the player can play a recording from, where the browser can. */
function urlFor(blob: Blob): string | undefined {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : undefined
}

const recorder = new MicrophoneRecorder(browserRecorderDeps(), {
  state: (next, why) => {
    state.value = next
    failure.value = why
    if (next !== 'recording') level.value = 0
  },
  elapsed: (seconds) => {
    elapsed.value = seconds
  },
  level: (value) => {
    level.value = value
  },
  recorded: (blob) => {
    void takeRecording(blob)
  },
})

/** Reads the recording the browser made, and keeps it for listening back and sending. */
async function takeRecording(blob: Blob): Promise<void> {
  forgetUrl()
  const recording = await readRecording(blob)
  if (!recording) {
    unreadable.value = true
    recorded.value = undefined
    return
  }
  unreadable.value = false
  recorded.value = recording
  url.value = urlFor(blob)
}

/** Forgets a file chosen before and what was said about it, and empties the picker, so the same file can be chosen again. */
function forgetFile(): void {
  chosenName.value = undefined
  chosenSeconds.value = undefined
  fileProblem.value = undefined
  if (fileInput.value) fileInput.value.value = ''
}

/** Starts recording, with the level meter unless the visitor prefers reduced motion. */
function record(): void {
  forgetUrl()
  forgetFile()
  recorded.value = undefined
  unreadable.value = false
  elapsed.value = 0
  showLevels.value = !prefersReducedMotion()
  void recorder.start({ levels: showLevels.value })
}

/** Takes a file the visitor chose, after the checks the service would make, so a file it would refuse is not sent. */
async function choose(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  forgetUrl()
  recorded.value = undefined
  unreadable.value = false
  recorder.discard()
  elapsed.value = 0
  chosenName.value = file.name
  chosenSeconds.value = undefined
  fileProblem.value = undefined
  if (file.size > MAX_UPLOAD_BYTES) {
    fileProblem.value = 'too_big'
    return
  }
  reading.value = true
  try {
    const recording = await readRecording(file)
    if (!recording) {
      fileProblem.value = 'unreadable'
      return
    }
    const playable = urlFor(file)
    const seconds = playable === undefined ? undefined : await durationOf(playable)
    if (seconds !== undefined && seconds > MAX_RECORDING_SECONDS + LENGTH_SLACK_SECONDS) {
      if (playable !== undefined && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(playable)
      chosenSeconds.value = Math.round(seconds)
      fileProblem.value = 'too_long'
      return
    }
    chosenSeconds.value = seconds === undefined ? undefined : Math.round(seconds)
    recorded.value = recording
    url.value = playable
  }
  finally {
    reading.value = false
  }
}

/**
 * Records, or stops the recording, from the one button that does both. While the browser asks for the microphone
 * the button says no to a press rather than being switched off, which would take the keyboard's focus away from it.
 */
function recordOrStop(): void {
  if (state.value === 'recording') recorder.stop()
  else if (state.value !== 'asking') record()
}

/** Forgets the recording, and gives the keyboard's focus back to the record button, since the buttons it was on are gone. */
async function discard(): Promise<void> {
  forgetUrl()
  forgetFile()
  recorded.value = undefined
  unreadable.value = false
  elapsed.value = 0
  recorder.discard()
  await nextTick()
  recordButton.value?.focus()
}

/** Hands the recording to the board, with the URL to play it from, and starts afresh. */
function send(): void {
  const recording = recorded.value
  if (!recording || !canSend.value) return
  const playback = url.value ?? ''
  // The board owns the URL from here on and lets go of it when it is done.
  url.value = undefined
  recorded.value = undefined
  elapsed.value = 0
  forgetFile()
  recorder.discard()
  emit('send', recording, playback)
}

onBeforeUnmount(() => {
  recorder.dispose()
  forgetUrl()
})

const recording = computed(() => state.value === 'recording')
const asking = computed(() => state.value === 'asking')
const left = computed(() => Math.max(MAX_RECORDING_SECONDS - elapsed.value, 0))
const share = computed(() => Math.round(level.value * 100))
const hasRecording = computed(() => recorded.value !== undefined)
const canSend = computed(() => hasRecording.value && props.canRunLive && !props.busy)
// The record button's words: stop while recording, record again after a recording from the microphone, record otherwise.
const recordLabel = computed(() => {
  if (recording.value) return t('lb09.recorder.stop')
  return hasRecording.value && chosenName.value === undefined ? t('lb09.recorder.again') : t('lb09.recorder.record')
})
const failureText = computed(() => (failure.value ? t(`lb09.recorder.failed.${failure.value}`) : t('lb09.recorder.failed.recorder')))
// What was chosen, said back: the file's name and its length when the browser could tell it.
const chosenText = computed(() => {
  if (chosenName.value === undefined) return ''
  return chosenSeconds.value === undefined ? t('lb09.recorder.file.chosen', { name: chosenName.value }) : t('lb09.recorder.file.chosenLength', { name: chosenName.value, seconds: chosenSeconds.value })
})
const fileProblemText = computed(() => (fileProblem.value ? t(`lb09.recorder.file.problems.${fileProblem.value}`, { seconds: chosenSeconds.value ?? 0, max: MAX_RECORDING_SECONDS }) : ''))
// What a screen reader hears as the recorder moves: the states that are not spoken by a button already.
const announcement = computed(() => {
  if (asking.value) return t('lb09.recorder.asking')
  if (recording.value) return t('lb09.recorder.recordingStarted')
  if (state.value === 'recorded') return t('lb09.recorder.recorded', { seconds: elapsed.value })
  if (fileProblem.value) return fileProblemText.value
  if (hasRecording.value && chosenName.value !== undefined) return chosenText.value
  return ''
})
</script>

<template>
  <section
    class="recorder"
    data-testid="recorder"
    :aria-labelledby="'lb09-recorder-title'"
  >
    <h2
      id="lb09-recorder-title"
      class="lb-label"
    >
      {{ t('lb09.recorder.title') }}
    </h2>

    <ul class="explain">
      <li>{{ t('lb09.recorder.explain.ask') }}</li>
      <li>{{ t('lb09.recorder.explain.stays') }}</li>
      <li>{{ t('lb09.recorder.explain.minute', { seconds: MAX_RECORDING_SECONDS }) }}</li>
      <li>{{ t('lb09.recorder.explain.deleted') }}</li>
      <li>{{ t('lb09.recorder.explain.language') }}</li>
    </ul>

    <p
      class="lb-sr-only"
      role="status"
      data-testid="recorder-announcement"
    >
      {{ announcement }}
    </p>

    <div
      v-if="state === 'unsupported'"
      class="state state--off"
      data-testid="recorder-unsupported"
    >
      <LbIcon
        name="info"
        :size="18"
      />
      <p>{{ t('lb09.recorder.unsupported') }}</p>
    </div>

    <div
      v-else-if="state === 'denied'"
      class="state state--off"
      data-testid="recorder-denied"
    >
      <LbIcon
        name="warning"
        :size="18"
      />
      <div>
        <p>{{ t('lb09.recorder.denied.text') }}</p>
        <p class="small">
          {{ t('lb09.recorder.denied.how') }}
        </p>
      </div>
    </div>

    <div
      v-else-if="state === 'failed'"
      class="state state--off"
      data-testid="recorder-failed"
    >
      <LbIcon
        name="error"
        :size="18"
      />
      <p>{{ failureText }}</p>
    </div>

    <div
      v-if="recording"
      class="live"
      data-testid="recorder-live"
    >
      <p class="count">
        <LbIcon
          name="live"
          :size="16"
        />
        <span>{{ t('lb09.recorder.countdown', { left, max: MAX_RECORDING_SECONDS }) }}</span>
      </p>
      <div
        v-if="showLevels"
        class="meter"
        role="img"
        :aria-label="t('lb09.recorder.level')"
        data-testid="level-meter"
      >
        <div
          class="fill"
          :style="{ width: `${share}%` }"
        />
      </div>
    </div>

    <div class="buttons">
      <!-- One button records and stops, so the keyboard's focus stays on it from one to the other. -->
      <button
        ref="recordButton"
        type="button"
        class="button button--primary"
        :data-testid="recording ? 'stop-recording' : 'record'"
        :disabled="busy && !recording"
        :aria-disabled="asking ? 'true' : undefined"
        @click="recordOrStop"
      >
        {{ recordLabel }}
      </button>
    </div>

    <p
      v-if="unreadable"
      class="small"
      data-testid="recorder-unreadable"
    >
      {{ t('lb09.recorder.unreadable') }}
    </p>

    <div class="file">
      <label
        for="lb09-file"
        class="file-label"
      >{{ t('lb09.recorder.file.label') }}</label>
      <input
        id="lb09-file"
        ref="fileInput"
        type="file"
        class="file-input"
        :accept="ACCEPTED_FILES"
        :disabled="recording || asking || reading"
        :aria-describedby="fileProblem ? 'lb09-file-hint lb09-file-problem' : 'lb09-file-hint'"
        :aria-invalid="fileProblem !== undefined"
        data-testid="file-input"
        @change="choose"
      >
      <p
        id="lb09-file-hint"
        class="small"
      >
        {{ t('lb09.recorder.file.hint', { max: MAX_RECORDING_SECONDS }) }}
      </p>
      <p
        v-if="fileProblem"
        id="lb09-file-problem"
        class="state state--off"
        data-testid="file-problem"
        :data-problem="fileProblem"
      >
        {{ fileProblemText }}
      </p>
    </div>

    <div
      v-if="hasRecording"
      class="made"
      data-testid="recorder-made"
    >
      <p class="lb-label">
        {{ t('lb09.recorder.listen') }}
      </p>
      <p
        v-if="chosenName !== undefined"
        class="small"
        data-testid="file-chosen"
      >
        {{ chosenText }}
      </p>
      <AudioPlayer
        :src="url"
        :label="t('lb09.player.own')"
      />
      <p
        v-if="allowanceUsedUp"
        class="small"
        data-testid="recorder-no-allowance"
      >
        {{ t('lb09.recorder.noAllowance') }}
      </p>
      <p
        v-else-if="!canRunLive"
        class="small"
      >
        {{ t('lb09.recorder.noLive') }}
      </p>
      <p
        v-else
        class="small"
      >
        {{ t('lb09.recorder.liveCost') }}
      </p>
      <div class="buttons">
        <button
          type="button"
          class="button button--primary"
          data-testid="send-recording"
          :disabled="!canSend"
          @click="send"
        >
          {{ t('lb09.recorder.send') }}
        </button>
        <button
          type="button"
          class="button"
          data-testid="discard-recording"
          @click="discard"
        >
          {{ t('lb09.recorder.discard') }}
        </button>
      </div>
    </div>

    <p class="privacy">
      {{ t('lb09.recorder.privacy') }}
    </p>
  </section>
</template>

<style scoped>
.recorder {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.explain {
  display: grid;
  gap: 4px;
  padding-left: 18px;
  margin: 0;
  font-size: 14px;
}

.state {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  font-size: 14px;
  border: 1px solid var(--lb-rule);
}

.state--off {
  background: var(--lb-shade);
}

.small {
  font-size: 13px;
  color: var(--lb-graphite);
}

.live {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  background: var(--lb-board-tint);
  border: 1px dashed var(--lb-board);
}

.count {
  display: flex;
  gap: 8px;
  align-items: center;
  font-family: var(--lb-font-mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.meter {
  height: 8px;
  overflow: hidden;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-ink);
}

.fill {
  height: 100%;
  background: var(--lb-board);
  transition: width 90ms linear;
}

@media (prefers-reduced-motion: reduce) {
  .fill {
    transition: none;
  }
}

.made {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--lb-rule);
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

.privacy {
  font-size: 13px;
  color: var(--lb-graphite);
}

.file {
  display: grid;
  gap: 6px;
  justify-items: start;
}

.file-label {
  font-size: 14px;
  font-weight: 600;
}

.file-input {
  max-width: 100%;
  font: 13.5px var(--lb-font-sans);
  color: var(--lb-ink);
}

.file-input::file-selector-button {
  padding: 7px 14px;
  margin-right: 10px;
  font: 600 13px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.file-input:disabled::file-selector-button {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
