<script setup lang="ts">
// <SentPanel>: what the sandbox "sent", and the proof that each thing went out once. A write
// step (Slack, email, webhook, task) writes a row in this demo's own table under a key made of the
// chain's first run and the step. A retry of the step, or a replay of the whole run, finds the key
// already used and writes nothing, and the log says so. This panel reads that out of the runs'
// logs and sets it beside the table itself: the log claims so many were sent and so many were
// recognised, and the table holds that many rows, one for each thing. Nothing here left the system.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { wordsFrom } from '../graph/words'
import type { EffectRow } from '../run/effects'
import { stepName, valueWords } from '../run/narrate'
import { useLb08Store } from '../store'

defineProps<{
  /** The Brief reading leaves out the keys and the figures. */
  brief: boolean
}>()

const { t, te } = useI18n()
const store = useLb08Store()
const { currentRun, chain, ledger, sent, runGraph } = storeToRefs(store)

const words = wordsFrom((key, params) => t(key, params), key => te(key))
const rootRunId = computed(() => chain.value[0]?.rootRunId ?? '')
const summary = computed(() => {
  if (ledger.value.rows.length === 0) return t('lb08.sent.empty')
  if (sent.value === undefined) return t('lb08.sent.summaryUnchecked')
  return ledger.value.once ? t('lb08.sent.summaryOnce') : undefined
})
const figures = computed(() => t('lb08.sent.summaryFigures', { sent: ledger.value.sentEvents, suppressed: ledger.value.suppressed, recorded: ledger.value.recorded }))

/** A step's name. */
function nameOf(nodeId: string): string {
  return stepName(runGraph.value, nodeId)
}

/** The number of a run in the chain, from 1. */
function numberOf(runId: string): number {
  return chain.value.findIndex(run => run.id === runId) + 1
}

/** The words for the name of a thing a connector sent. */
function fieldName(connector: string, name: string): string {
  const key = `lb08.fields.${connector}.${name}.label`
  return te(key) ? t(key) : name
}

/** What a connector sent, as named lines. */
function contentOf(row: EffectRow): { name: string, text: string }[] {
  return Object.entries(row.content ?? {}).map(([name, value]) => ({ name: fieldName(row.connector, name), text: valueWords(words, value) }))
}

/** What happened around a delivery, as sentences. */
function notesOf(row: EffectRow): string[] {
  const notes = [t('lb08.sent.noteSent', { run: numberOf(row.sentInRun) })]
  if (row.failedAttempts > 0) notes.push(t('lb08.sent.noteRetries', { count: row.failedAttempts }))
  for (const runId of row.recognisedIn) notes.push(t('lb08.sent.noteRecognised', { run: numberOf(runId) }))
  return notes
}
</script>

<template>
  <section
    v-if="currentRun"
    class="lb8-section"
    :aria-label="t('lb08.sent.title')"
    data-testid="sent"
  >
    <h2>{{ t('lb08.sent.title') }}</h2>
    <p class="lb8-hint">
      {{ t('lb08.sent.help') }}
    </p>
    <p
      v-if="summary"
      class="summary"
      role="status"
      data-testid="sent-summary"
    >
      <LbIcon
        :name="ledger.once ? 'success' : 'info'"
        :size="16"
        tone="mono"
      />
      {{ summary }}
    </p>
    <p
      v-if="sent !== undefined && ledger.rows.length > 0 && (!brief || !ledger.once)"
      class="lb8-hint lb8-mono"
      data-testid="sent-figures"
    >
      {{ figures }}
    </p>
    <div
      v-if="ledger.rows.length > 0"
      class="lb8-table-wrap"
      role="region"
      tabindex="0"
      :aria-label="t('lb08.sent.title')"
    >
      <table class="lb8-table">
        <caption class="lb-sr-only">
          {{ t('lb08.sent.title') }}
        </caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('lb08.sent.columns.step') }}
            </th>
            <th scope="col">
              {{ t('lb08.sent.columns.connector') }}
            </th>
            <th scope="col">
              {{ t('lb08.sent.columns.content') }}
            </th>
            <th scope="col">
              {{ t('lb08.sent.columns.message') }}
            </th>
            <th scope="col">
              {{ t('lb08.sent.columns.notes') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in ledger.rows"
            :key="row.nodeId"
            data-testid="sent-row"
            :data-step="row.nodeId"
          >
            <th scope="row">
              {{ nameOf(row.nodeId) }}
            </th>
            <td>{{ t(`lb08.connectors.${row.connector}`) }}</td>
            <td>
              <span
                v-if="row.content === undefined"
                class="lb8-hint"
              >{{ t('lb08.status.working') }}</span>
              <dl
                v-else
                class="content"
              >
                <div
                  v-for="line in contentOf(row)"
                  :key="line.name"
                >
                  <dt class="lb8-hint">
                    {{ line.name }}
                  </dt>
                  <dd class="lb8-mono">
                    {{ line.text }}
                  </dd>
                </div>
              </dl>
            </td>
            <td>
              <span class="lb8-mono">{{ row.messageId }}</span>
              <span
                v-if="!brief"
                class="lb8-hint lb8-mono key"
              >{{ t('lb08.sent.key', { key: `${rootRunId}:${row.nodeId}` }) }}</span>
            </td>
            <td>
              <ul class="notes">
                <li
                  v-for="note in notesOf(row)"
                  :key="note"
                >
                  {{ note }}
                </li>
              </ul>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.summary {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
}

.content {
  display: grid;
  gap: 2px;
  margin: 0;
}

.content dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.key {
  display: block;
  overflow-wrap: anywhere;
}

.notes {
  display: grid;
  gap: 2px;
  padding: 0;
  margin: 0;
  list-style: none;
}
</style>
