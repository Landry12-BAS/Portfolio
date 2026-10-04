<script setup lang="ts">
// <DocumentShelf>: the visitor's own documents of the hour, newest first, so a reading can be opened again
// after the page is reloaded and a document can be deleted before its hour is up. Each shows its file name,
// where it is (being read, ready, or failed), and for a read one how many checks failed and whether it can
// be exported. A document can be deleted once it has ended; one that is still being read cannot, and the
// button says so by being off. Everything here is the visitor's own (the service shows a visitor no one
// else's), and the service deletes each document itself an hour after it was uploaded.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatSize } from '../upload'
import { isFinal } from '../progress'
import type { DocumentSummary } from '../schemas'

const props = defineProps<{
  /** The visitor's documents of the hour. */
  documents: readonly DocumentSummary[]
  /** Whether the list is being read, was read, or could not be. */
  status: 'idle' | 'loading' | 'ready' | 'failed'
  /** The ID of the document on the board, if it is one of these. */
  currentId: string | undefined
  /** True while the board is busy with a document, so another cannot be opened under it. */
  busy: boolean
  /** True while a delete is being sent. */
  deleting: boolean
}>()

const emit = defineEmits<{
  open: [id: string]
  remove: [id: string]
}>()

const { t, locale } = useI18n()

// The ten newest: a visitor has ten documents a day, and the hour keeps fewer.
const shown = computed(() => props.documents.slice(0, 10))

/** Says how a document stands, in words: its state, and for a read one how many checks failed. */
function standing(item: DocumentSummary): string {
  if (item.state === 'ready') {
    const failed = item.checks_failed ?? 0
    return failed === 0 ? t('lb03.shelf.allPassed') : t('lb03.shelf.someFailed', { count: failed })
  }
  if (item.state === 'failed') return t('lb03.state.failed')
  return t('lb03.state.reading')
}
</script>

<template>
  <section
    class="shelf"
    :aria-label="t('lb03.shelf.title')"
    data-testid="shelf"
  >
    <h2 class="lb-label">
      {{ t('lb03.shelf.title') }}
    </h2>
    <p
      v-if="status === 'failed'"
      class="none"
    >
      {{ t('lb03.shelf.failed') }}
    </p>
    <p
      v-else-if="shown.length === 0"
      class="none"
      data-testid="shelf-empty"
    >
      {{ t('lb03.shelf.empty') }}
    </p>
    <ul
      v-else
      class="list"
    >
      <li
        v-for="item in shown"
        :key="item.id"
        class="item"
        :class="{ current: item.id === currentId }"
        data-testid="shelf-item"
      >
        <p class="label">
          {{ item.label }}
        </p>
        <p class="facts">
          {{ standing(item) }} · {{ formatSize(item.byte_size, locale) }}
        </p>
        <div class="buttons">
          <button
            type="button"
            class="button"
            :disabled="busy || item.id === currentId"
            :aria-label="t('lb03.shelf.openLabel', { name: item.label })"
            data-testid="shelf-open"
            @click="emit('open', item.id)"
          >
            {{ t('lb03.shelf.open') }}
          </button>
          <button
            type="button"
            class="button"
            :disabled="deleting || !isFinal(item.state)"
            :aria-label="t('lb03.shelf.deleteLabel', { name: item.label })"
            data-testid="shelf-delete"
            @click="emit('remove', item.id)"
          >
            {{ t('lb03.shelf.delete') }}
          </button>
        </div>
      </li>
    </ul>
    <p class="hint">
      {{ t('lb03.shelf.hint') }}
    </p>
  </section>
</template>

<style scoped>
.shelf {
  display: grid;
  gap: 8px;
}

.none,
.hint {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.list {
  display: grid;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.item {
  display: grid;
  gap: 3px;
  padding: 8px 10px;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.item.current {
  border-color: var(--lb-board);
}

.label {
  font-size: 13.5px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.facts {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 3px;
}

.button {
  padding: 4px 10px;
  font: 600 12.5px/1.2 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.button:hover:not(:disabled) {
  background: var(--lb-shade);
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
