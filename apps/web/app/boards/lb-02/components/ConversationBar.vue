<script setup lang="ts">
// <ConversationBar>: the controls over a conversation that has started, between the start panel and
// the phone. One button stays in one place: "End the conversation" while a live conversation goes on
// (connecting, open or reconnecting), and "Start a new conversation" once it has ended or finished or
// while a replay shows, so the keyboard's focus is never left on a button that disappears. When the
// connection ended for good, a message says why in plain words (by the kind of ending, never the
// server's own text) and offers what can be done: pick the conversation up where it was, if it still
// exists, or start another.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { End, EndReason } from '../socket'

/** The endings after which the conversation is still on the server and can be picked up again. */
const RESUMABLE: ReadonlySet<EndReason> = new Set<EndReason>(['lost', 'timed_out', 'too_big', 'unavailable', 'unauthorized', 'visitor'])
/** The endings that are a failure to act on and interrupt a screen reader, as against a state to know about. */
const FAILURES: ReadonlySet<EndReason> = new Set<EndReason>(['lost', 'malformed', 'bad_frame', 'grant_failed', 'unavailable', 'unauthorized', 'too_big'])

const props = defineProps<{
  mode: 'live' | 'replay'
  /** How the connection ended for good, when it did. */
  ending: End | undefined
  /** Whether the conversation exists on the server, so it can be picked up again. */
  hasConversation: boolean
  /** Whether the conversation finished by itself: the booking is made or a person has taken over. */
  finished: boolean
}>()

const emit = defineEmits<{ end: [], again: [], resume: [], retry: [] }>()

const { t } = useI18n()

const ending = computed(() => props.ending)
const canResume = computed(() => ending.value !== undefined && props.hasConversation && !props.finished && RESUMABLE.has(ending.value.reason))
const canRetry = computed(() => ending.value?.reason === 'grant_failed')
const failure = computed(() => ending.value !== undefined && FAILURES.has(ending.value.reason))
const ends = computed(() => props.mode === 'live' && props.ending === undefined && !props.finished)
</script>

<template>
  <div
    class="bar"
    data-testid="conversation-bar"
  >
    <p
      v-if="ending"
      class="message"
      :role="failure ? 'alert' : 'status'"
      :data-reason="ending.reason"
      data-testid="ended"
    >
      {{ t(`lb02.ended.${ending.reason}`) }}
    </p>
    <div class="buttons">
      <button
        v-if="canResume"
        type="button"
        class="button button--primary"
        data-testid="resume-ended"
        @click="emit('resume')"
      >
        {{ t('lb02.ended.resume') }}
      </button>
      <button
        v-if="canRetry"
        type="button"
        class="button button--primary"
        data-testid="retry-ended"
        @click="emit('retry')"
      >
        {{ t('lb02.ended.retry') }}
      </button>
      <button
        v-if="ends"
        type="button"
        class="button"
        data-testid="end"
        @click="emit('end')"
      >
        {{ t('lb02.end.button') }}
      </button>
      <button
        v-else
        type="button"
        class="button"
        data-testid="again"
        @click="emit('again')"
      >
        {{ t('lb02.end.again') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
  justify-content: space-between;
}

.message {
  flex: 1 1 280px;
  max-width: 70ch;
  padding: 10px 12px;
  font-size: 14px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-ink);
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

.button:hover {
  background: var(--lb-shade);
}

.button--primary {
  color: var(--lb-sheet);
  background: var(--lb-ink);
}

.button--primary:hover {
  background: var(--lb-ink-hover);
}
</style>
