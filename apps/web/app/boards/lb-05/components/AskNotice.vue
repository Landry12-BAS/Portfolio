<script setup lang="ts">
// <AskNotice>: the words for the few things that can happen to a question that the kit's notices do
// not cover: the visitor's last question is still running (the back end takes one at a time), the
// visitor stopped waiting for a question that the analyst is still working on, and the analyst could
// not answer right now, which does not count against the day. They look like the kit's notices. The
// wording comes from the locale files by kind; the one sentence from the back end (why it could not
// answer) is shown as a quotation in its own language, never as the page's words.
import { LbIcon } from '@lb/icons'
import { useI18n } from 'vue-i18n'

defineProps<{
  kind: 'busy' | 'stopped' | 'unavailable'
  /** The back end's own sentence about why there is no answer, for the unavailable notice. */
  detail?: string | null
  /** Offers a "Try again" button. */
  retryable?: boolean
}>()

const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n()
</script>

<template>
  <div
    class="notice"
    role="status"
    :data-kind="kind"
    data-testid="ask-notice"
  >
    <LbIcon
      name="info"
      :size="20"
    />
    <div class="body">
      <p class="title">
        {{ kind === 'unavailable' ? t('lb05.answer.outcomes.unavailable') : t(`lb05.${kind}.title`) }}
      </p>
      <p class="text">
        {{ kind === 'unavailable' ? t('lb05.answer.unavailableText') : t(`lb05.${kind}.text`) }}
      </p>
      <p
        v-if="kind === 'unavailable' && detail"
        class="text"
        lang="en"
        data-testid="ask-notice-detail"
      >
        {{ detail }}
      </p>
      <div
        v-if="retryable"
        class="actions"
      >
        <button
          type="button"
          class="button"
          @click="emit('retry')"
        >
          {{ t('lb05.busy.retry') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notice {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-ink);
}

.body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.title {
  font-weight: 700;
}

.text {
  font-size: 14px;
}

.actions {
  display: flex;
  margin-top: 6px;
}

.button {
  padding: 6px 12px;
  font: 600 13px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.button:hover {
  background: var(--lb-sheet);
}
</style>
