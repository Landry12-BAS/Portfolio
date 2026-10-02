<script setup lang="ts">
// <SampleScript>: the messages of a curated sample that is run live, listed with which are sent and
// which come next, and the buttons that send them: the next one, or all of them one after another,
// each after the concierge has answered the one before. The visitor can stop at any message and
// write their own: the conversation is a real one. The sample's messages are fixed text from the
// golden set; nothing here changes what is sent.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { typeset } from '~/board-kit/format'

import type { Script } from '../store'

const props = defineProps<{
  script: Script
  /** The language the sample is written in. */
  language: string
  /** Whether a message can be sent right now: the conversation is open and the concierge is not answering. */
  canSend: boolean
}>()

const emit = defineEmits<{ next: [], all: [], stop: [] }>()

const { t } = useI18n()

// The words for where a message stands in the script.
const PLACE_WORDS = { sent: 'lb02.script.sent', next: 'lb02.script.upNext', later: 'lb02.script.later' } as const

const total = computed(() => props.script.turns.length)
const finished = computed(() => props.script.sent >= total.value)

/** Says where a message stands in the script: already sent, the one that goes next, or still to come. */
function placeOf(index: number): 'sent' | 'next' | 'later' {
  if (index < props.script.sent) return 'sent'
  return index === props.script.sent ? 'next' : 'later'
}
</script>

<template>
  <section
    class="script"
    :aria-label="t('lb02.script.title')"
    data-testid="script"
  >
    <h2 class="lb-label">
      {{ t('lb02.script.title') }}
    </h2>
    <p
      class="progress"
      role="status"
      data-testid="script-progress"
    >
      {{ t('lb02.script.progress', { done: script.sent, total }) }}
    </p>
    <ol class="messages">
      <li
        v-for="(turn, index) in script.turns"
        :key="index"
        :data-place="placeOf(index)"
      >
        <span class="tag">{{ t(PLACE_WORDS[placeOf(index)]) }}</span>
        <span
          class="text"
          :lang="language"
        >{{ typeset(turn.say, language) }}</span>
        <span
          v-if="turn.waitMinutes > 0"
          class="wait"
        >{{ t('lb02.start.waitsBefore', { minutes: turn.waitMinutes }) }}</span>
      </li>
    </ol>
    <p
      v-if="finished"
      class="done"
      data-testid="script-finished"
    >
      {{ t('lb02.script.finished') }}
    </p>
    <div
      v-else
      class="buttons"
    >
      <button
        type="button"
        class="button button--primary"
        :disabled="!canSend"
        data-testid="script-next"
        @click="emit('next')"
      >
        {{ t('lb02.script.next') }}
      </button>
      <button
        v-if="!script.autoplay"
        type="button"
        class="button"
        :disabled="!canSend"
        data-testid="script-all"
        @click="emit('all')"
      >
        {{ t('lb02.script.all') }}
      </button>
      <button
        v-else
        type="button"
        class="button"
        data-testid="script-stop"
        @click="emit('stop')"
      >
        {{ t('lb02.script.stop') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.script {
  display: grid;
  gap: 10px;
  padding: 14px;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.progress,
.done {
  font-size: 13px;
  color: var(--lb-graphite);
}

.messages {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.messages li {
  display: grid;
  gap: 2px;
  padding-left: 10px;
  border-left: 3px solid var(--lb-rule);
}

.messages li[data-place="next"] {
  border-left-color: var(--lb-signal);
}

.messages li[data-place="sent"] .text {
  color: var(--lb-graphite);
}

.tag {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.text {
  font-size: 13.5px;
}

.wait {
  font-size: 12px;
  color: var(--lb-graphite);
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.button {
  padding: 8px 14px;
  font: 600 13px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
}

.button--primary {
  color: var(--lb-sheet);
  background: var(--lb-ink);
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
