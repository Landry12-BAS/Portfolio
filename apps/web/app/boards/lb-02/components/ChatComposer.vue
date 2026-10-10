<script setup lang="ts">
// <ChatComposer>: where the visitor writes to the concierge. Enter sends and Shift and Enter start a new
// line, as in any chat; the field keeps the keyboard's focus while the concierge answers, so the next
// message can be written at once and only sending waits. What the field is for (nothing to write yet,
// a replay, a finished conversation, no connection) is said in words beside it, and the limit of 500
// characters is counted for the visitor. A message the page is not sure was sent is put back in the field.
import { LbIcon } from '@lb/icons'
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { MAX_MESSAGE_LENGTH } from '../wire'

const props = defineProps<{
  /**
   * What the composer can do now: nothing to write to yet, a connection being made, ready, a conversation
   * a person has taken over, a connection that ended, a replay, or no connection.
   */
  mode: 'idle' | 'connecting' | 'ready' | 'finished' | 'ended' | 'replay' | 'offline'
  /** True while the concierge is answering: the visitor may write the next message, but sending waits. */
  working: boolean
  /** The language of the conversation, for the field's spelling check and the voice of a screen reader. */
  language: string
  /** A message that may not have been sent, which goes back in the field. */
  unsent: string | undefined
  /** How many messages the conversation takes; at zero the next one hands it to a person. */
  messagesLeft: number
}>()

const emit = defineEmits<{ send: [text: string] }>()

const { t } = useI18n()
const hintId = useId()
const field = ref<HTMLTextAreaElement>()
const text = ref('')

const canSend = computed(() => props.mode === 'ready' && !props.working && text.value.trim().length > 0)
const hint = computed(() => {
  if (props.mode === 'idle') return t('lb02.composer.notStarted')
  if (props.mode === 'replay') return t('lb02.composer.replaying')
  if (props.mode === 'finished') return t('lb02.composer.finished')
  if (props.mode === 'connecting') return t('lb02.composer.connecting')
  if (props.mode === 'ended') return t('lb02.composer.ended')
  if (props.mode === 'offline') return t('lb02.composer.offline')
  if (props.working) return t('lb02.composer.waiting')
  if (props.messagesLeft <= 0) return t('lb02.composer.lastMessage')
  return t('lb02.composer.hint')
})

// A message that may not have been sent comes back into the field, unless the visitor has already started another.
watch(() => props.unsent, (message) => {
  if (message !== undefined && text.value === '') text.value = message
})

/** Sends what is written, if it can be sent, and empties the field. */
function submit(): void {
  if (!canSend.value) return
  emit('send', text.value.trim())
  text.value = ''
}

/** Sends on Enter; Shift and Enter write a new line, and a key that is part of composing a character is left alone. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}

/** Puts the keyboard's focus in the field. */
function focus(): void {
  field.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <form
    class="composer"
    @submit.prevent="submit"
  >
    <label
      class="lb-sr-only"
      :for="`${hintId}-field`"
    >{{ t('lb02.composer.label') }}</label>
    <textarea
      :id="`${hintId}-field`"
      ref="field"
      v-model="text"
      class="field"
      rows="2"
      :maxlength="MAX_MESSAGE_LENGTH"
      :disabled="mode !== 'ready'"
      :lang="/^[a-z]{2}$/.test(language) ? language : undefined"
      :aria-describedby="hintId"
      enterkeyhint="send"
      autocomplete="off"
      data-testid="composer-field"
      @keydown="onKeydown"
    />
    <div class="row">
      <p
        :id="hintId"
        class="hint"
        data-testid="composer-hint"
      >
        {{ hint }}
      </p>
      <span
        v-if="mode === 'ready'"
        class="count"
      >{{ t('lb02.composer.counter', { count: text.length, max: MAX_MESSAGE_LENGTH }) }}</span>
      <button
        type="submit"
        class="send"
        :disabled="!canSend"
        data-testid="send"
      >
        <LbIcon
          name="arrow-up-right"
          :size="16"
          tone="mono"
        />
        {{ t('lb02.composer.send') }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.composer {
  display: grid;
  gap: 6px;
  padding: 10px 12px 12px;
  border-top: 1px solid var(--lb-rule);
}

.field {
  width: 100%;
  padding: 8px 10px;
  font: 400 14px/1.45 var(--lb-font-sans);
  color: var(--lb-ink);
  resize: none;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
  border-radius: 12px;
}

.field:disabled {
  color: var(--lb-graphite);
  background: var(--lb-shade);
  border-color: var(--lb-rule);
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
}

.hint {
  flex: 1 1 140px;
  font-size: 12px;
  color: var(--lb-graphite);
}

.count {
  font-family: var(--lb-font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--lb-graphite);
}

.send {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 8px 14px;
  font: 600 13px/1 var(--lb-font-sans);
  color: var(--lb-sheet);
  cursor: pointer;
  background: var(--lb-ink);
  border: 1.5px solid var(--lb-ink);
  border-radius: 999px;
}

.send:hover:not(:disabled) {
  background: var(--lb-ink-hover);
}

.send:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
