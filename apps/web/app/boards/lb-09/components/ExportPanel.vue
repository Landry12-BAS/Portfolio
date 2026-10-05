<script setup lang="ts">
// <ExportPanel>: the meeting as a file to take away, made in the browser from what the board
// already holds (export.ts mirrors the API's own exports): JSON for a program, CSV for a
// spreadsheet, and the plain-English follow-up to paste into Automation Studio (LB-08), which takes
// a workflow described in words. The text is shown, can be copied, and can be saved as a file; a
// replay exports the same thing a live run does, since nothing here asks the back end.
import { LbIcon } from '@lb/icons'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { EXPORT_FORMATS, exportMeeting } from '../export'
import type { ExportFormat } from '../export'
import type { Item, Meeting, Segment } from '../schemas'

const props = defineProps<{
  meeting: Meeting
  segments: readonly Segment[]
  items: readonly Item[]
}>()

const { t } = useI18n()

const format = ref<ExportFormat>('text')
const copied = ref(false)
const fileUrl = ref<string>()
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const formatOptions = computed(() => EXPORT_FORMATS.map(value => ({ value, label: t(`lb09.export.formats.${value}`) })))
const file = computed(() => exportMeeting(format.value, props.meeting, props.segments, props.items))

/** Lets go of the URL made for the file, where the browser can. */
function forgetUrl(): void {
  if (fileUrl.value !== undefined && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(fileUrl.value)
  fileUrl.value = undefined
}

// The file to save is remade whenever the export changes.
watch(file, (next) => {
  forgetUrl()
  if (typeof URL.createObjectURL === 'function') fileUrl.value = URL.createObjectURL(new Blob([next.content], { type: next.contentType }))
}, { immediate: true })

/** Copies the export to the clipboard, where the browser lets a page do that. */
async function copy(): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard
  if (!clipboard || typeof clipboard.writeText !== 'function') return
  try {
    await clipboard.writeText(file.value.content)
    copied.value = true
    if (copiedTimer !== undefined) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 2_000)
  }
  catch {
    // The browser refused: the text is on the page to select by hand.
  }
}

onBeforeUnmount(() => {
  forgetUrl()
  if (copiedTimer !== undefined) clearTimeout(copiedTimer)
})
</script>

<template>
  <section
    class="export"
    data-testid="export"
    :aria-labelledby="'lb09-export-title'"
  >
    <h2
      id="lb09-export-title"
      class="lb-label"
    >
      {{ t('lb09.export.title') }}
    </h2>
    <p class="note">
      {{ t('lb09.export.note') }}
    </p>
    <LbSegmented
      v-model="format"
      :options="formatOptions"
      :label="t('lb09.export.formatLabel')"
    />
    <textarea
      class="content"
      readonly
      rows="8"
      :aria-label="t('lb09.export.contentLabel')"
      :value="file.content"
      data-testid="export-content"
    />
    <div class="buttons">
      <button
        type="button"
        class="button"
        data-testid="export-copy"
        @click="copy"
      >
        <LbIcon
          name="copy"
          :size="14"
        />
        {{ copied ? t('lb09.export.copied') : t('lb09.export.copy') }}
      </button>
      <a
        v-if="fileUrl"
        class="button"
        :href="fileUrl"
        :download="file.filename"
        data-testid="export-download"
      >
        <LbIcon
          name="download"
          :size="14"
        />
        {{ t('lb09.export.download', { name: file.filename }) }}
      </a>
    </div>
    <p
      v-if="format === 'text'"
      class="note"
      data-testid="export-lb08"
    >
      {{ t('lb09.export.lb08') }}
      <NuxtLinkLocale to="/systems/lb-08/board">
        {{ t('lb09.export.openLb08') }}
      </NuxtLinkLocale>
    </p>
  </section>
</template>

<style scoped>
.export {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.note {
  font-size: 13px;
  color: var(--lb-graphite);
}

.content {
  width: 100%;
  padding: 8px 10px;
  font: 12.5px/1.5 var(--lb-font-mono);
  color: var(--lb-ink);
  resize: vertical;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.button {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 8px 14px;
  font: 600 13px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  text-decoration: none;
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.button:hover {
  background: var(--lb-shade);
}
</style>
