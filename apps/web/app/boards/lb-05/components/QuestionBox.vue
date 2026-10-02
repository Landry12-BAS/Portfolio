<script setup lang="ts">
// <QuestionBox>: a labelled text box for a question of the visitor's own, with its length counted
// against what the back end takes (five to 300 characters) and one button to send it. It is used for
// a business question and for an attack, which differ only in their words, so the words are given by
// the parent. It collects the text and reports it; the board decides what to do with it.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { MAX_QUESTION_CHARS, MIN_QUESTION_CHARS } from '../limits'

const props = defineProps<{
  /** Makes the ids of the box's parts unique on the page. */
  idBase: string
  label: string
  hint: string
  submitLabel: string
  /** True while a question is being asked, which turns the button into a statement of the wait. */
  busy: boolean
  /** True when a live question cannot be asked now, for a reason the parent explains. */
  disabled: boolean
}>()

const emit = defineEmits<{ submit: [question: string] }>()

const { t } = useI18n()

const text = ref('')
const length = computed(() => text.value.trim().length)
const acceptable = computed(() => length.value >= MIN_QUESTION_CHARS && length.value <= MAX_QUESTION_CHARS)
const canSubmit = computed(() => !props.busy && !props.disabled && acceptable.value)

/** Reports the question the visitor wrote. */
function submit(): void {
  if (canSubmit.value) emit('submit', text.value.trim())
}
</script>

<template>
  <form
    class="box"
    @submit.prevent="submit"
  >
    <label :for="`${idBase}-text`">{{ label }}</label>
    <textarea
      :id="`${idBase}-text`"
      v-model="text"
      class="control"
      rows="3"
      :maxlength="MAX_QUESTION_CHARS"
      :aria-describedby="`${idBase}-hint`"
      data-testid="question-text"
    />
    <p
      :id="`${idBase}-hint`"
      class="hint"
    >
      {{ hint }}
      <span class="count">{{ t('lb05.ask.counter', { count: text.length, max: MAX_QUESTION_CHARS }) }}</span>
    </p>
    <div class="buttons">
      <button
        type="submit"
        class="button button--primary"
        :disabled="!canSubmit"
        data-testid="ask-own"
      >
        {{ busy ? t('lb05.ask.asking') : submitLabel }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.box {
  display: grid;
  gap: 6px;
  justify-items: start;
}

label {
  font-size: 13px;
  font-weight: 700;
}

.control {
  width: 100%;
  padding: 8px 10px;
  font: 400 14px/1.5 var(--lb-font-sans);
  color: var(--lb-ink);
  resize: vertical;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.hint {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.count {
  margin-left: 8px;
  font-family: var(--lb-font-mono);
  font-variant-numeric: tabular-nums;
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
