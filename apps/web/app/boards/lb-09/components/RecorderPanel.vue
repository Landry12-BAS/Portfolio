<script setup lang="ts">
// <RecorderPanel>: the visitor's own recording, up to a minute. Before anything is asked of the
// browser the panel says what will happen: the browser will ask for the microphone, the audio stays
// in this page until the visitor sends it, a recording is a minute at most, and the back end deletes
// the audio once it is transcribed. Pressing record asks for the microphone; while recording the
// panel counts down the seconds and draws the sound level (not for a visitor who prefers reduced
// motion). When the recording stops the visitor can listen back, send it, or discard it. A browser
// that cannot record, a microphone that was refused, and a microphone that could not be read each get
// their own words, and none of them is treated as the site failing.
import { LbIcon } from '@lb/icons'
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { readRecording } from '../audio'
import type { Recording } from '../audio'
import { browserRecorderDeps, MicrophoneRecorder } from '../recorder'
import type { RecorderFailure, RecorderState } from '../recorder'
import { MAX_RECORDING_SECONDS } from '../schemas'
import AudioPlayer from './AudioPlayer.vue'

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

/** Starts recording, with the level meter unless the visitor prefers reduced motion. */
function record(): void {
  forgetUrl()
  recorded.value = undefined
  unreadable.value = false
  elapsed.value = 0
  void recorder.start({ levels: !prefersReducedMotion() })
}

/** Stops the recording. */
function stop(): void {
  recorder.stop()
}

/** Forgets the recording. */
function discard(): void {
  forgetUrl()
  recorded.value = undefined
  unreadable.value = false
  elapsed.value = 0
  recorder.discard()
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
const failureText = computed(() => (failure.value ? t(`lb09.recorder.failed.${failure.value}`) : t('lb09.recorder.failed.recorder')))
// What a screen reader hears as the recorder moves: the states that are not spoken by a button already.
const announcement = computed(() => {
  if (asking.value) return t('lb09.recorder.asking')
  if (recording.value) return t('lb09.recorder.recordingStarted')
  if (state.value === 'recorded') return t('lb09.recorder.recorded', { seconds: elapsed.value })
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
      <button
        v-if="!recording"
        type="button"
        class="button button--primary"
        data-testid="record"
        :disabled="asking || busy"
        @click="record"
      >
        {{ hasRecording ? t('lb09.recorder.again') : t('lb09.recorder.record') }}
      </button>
      <button
        v-else
        type="button"
        class="button button--primary"
        data-testid="stop-recording"
        @click="stop"
      >
        {{ t('lb09.recorder.stop') }}
      </button>
    </div>

    <p
      v-if="unreadable"
      class="small"
      data-testid="recorder-unreadable"
    >
      {{ t('lb09.recorder.unreadable') }}
    </p>

    <div
      v-if="hasRecording"
      class="made"
      data-testid="recorder-made"
    >
      <p class="lb-label">
        {{ t('lb09.recorder.listen') }}
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
</style>
