<script setup lang="ts">
// <ExportPanel>: the three files a read document can be exported as: its lines as CSV, its journal entry
// as CSV, and the whole reading as JSON (fields, checks, the entry and the corrections). Each is a link
// the browser follows with the visitor's own session (a plain download; nothing is fetched by script).
// The two CSV files are refused while a check that stops the export has failed, and the journal file while
// there is no entry; the JSON always goes, because it carries the checks. A file that is not available
// is shown as a disabled button with the reason beside it, so nobody has to guess why. A replay has no
// document at the service, so it has nothing to export, and says so.
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { EXPORT_FILE_NAMES, exportUrl } from '../urls'
import type { ExportFormat } from '../urls'

const props = defineProps<{
  /** The document's ID. */
  documentId: string
  /** Whether the service lets the CSV files go: no failed check stops the export. */
  canExport: boolean
  /** Whether the document made a journal entry. */
  journalMade: boolean
  /** True for a document of the visitor's own: a replay has no document to export. */
  live: boolean
}>()

const { t } = useI18n()

/** The exports, in the order they are offered, with whether each can go now and, if not, why. */
const exports = computed(() => {
  const formats: { format: ExportFormat, enabled: boolean, reason: string | undefined }[] = [
    { format: 'csv', enabled: props.live && props.canExport, reason: undefined },
    { format: 'journal', enabled: props.live && props.canExport && props.journalMade, reason: undefined },
    { format: 'json', enabled: props.live, reason: undefined },
  ]
  return formats.map((item) => {
    if (item.enabled) return item
    if (!props.live) return { ...item, reason: 'lb03.export.replay' }
    return { ...item, reason: props.canExport ? 'lb03.export.noJournal' : 'lb03.export.blocked' }
  })
})
</script>

<template>
  <section
    class="export"
    :aria-label="t('lb03.export.title')"
    data-testid="export"
  >
    <h3 class="lb-label">
      {{ t('lb03.export.title') }}
    </h3>
    <ul class="list">
      <li
        v-for="item in exports"
        :key="item.format"
        class="item"
        :data-format="item.format"
      >
        <a
          v-if="item.enabled"
          class="button"
          :href="exportUrl(documentId, item.format)"
          :download="EXPORT_FILE_NAMES[item.format]"
          data-testid="export-link"
        >
          <LbIcon
            name="download"
            :size="16"
            tone="mono"
          />
          {{ t(`lb03.export.formats.${item.format}.button`) }}
        </a>
        <button
          v-else
          type="button"
          class="button"
          disabled
          :aria-describedby="`export-${item.format}-reason`"
          data-testid="export-off"
        >
          <LbIcon
            name="download"
            :size="16"
            tone="mono"
          />
          {{ t(`lb03.export.formats.${item.format}.button`) }}
        </button>
        <p class="about">
          {{ t(`lb03.export.formats.${item.format}.about`) }}
        </p>
        <p
          v-if="item.reason"
          :id="`export-${item.format}-reason`"
          class="reason"
        >
          {{ t(item.reason) }}
        </p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.export {
  display: grid;
  gap: 8px;
  align-content: start;
  min-width: 0;
}

.list {
  display: grid;
  gap: 12px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.item {
  display: grid;
  gap: 3px;
  justify-items: start;
}

.button {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  padding: 7px 14px;
  font: 600 13px/1.2 var(--lb-font-sans);
  color: var(--lb-ink);
  text-decoration: none;
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
  opacity: 0.55;
}

.about {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.reason {
  font-size: 12.5px;
  font-weight: 700;
}
</style>
