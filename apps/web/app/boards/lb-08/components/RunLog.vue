<script setup lang="ts">
// <RunLog>: the log of a run, every event in the order it happened, each one told as a sentence.
// The log is the whole story of a run: the progress table is made from it, and so is a replay. When
// the board holds a run and its replays, a list picks which run's log to read, and it follows the
// newest run unless the visitor chose another. The Technical reading adds the event's own name
// beside each sentence, for those who want to match the log to the service's.
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { wordsFrom } from '../graph/words'
import { sentenceFor } from '../run/narrate'
import { useLb08Store } from '../store'

defineProps<{
  /** The Brief reading leaves out the events' own names. */
  brief: boolean
}>()

const { t, te } = useI18n()
const store = useLb08Store()
const { chain, currentRun, runGraph } = storeToRefs(store)

const words = wordsFrom((key, params) => t(key, params), key => te(key))
// The run the visitor chose to read; none means the newest.
const chosen = ref<string>()

const shown = computed(() => chain.value.find(run => run.id === chosen.value) ?? currentRun.value)

// A new run in the chain is the one to read, unless it is only the same chain growing.
watch(() => chain.value.length, () => {
  chosen.value = undefined
})

/** The time of day of an event, in UTC to the second. */
function timeOf(iso: string): string {
  return iso.slice(11, 19)
}

/** What a run of the chain is called in the list. */
function runName(index: number, replayed: boolean): string {
  return replayed ? t('lb08.run.chainReplay', { number: index + 1 }) : t('lb08.run.chainRun', { number: index + 1 })
}

/** Takes the run the visitor chose. */
function choose(event: Event): void {
  const target = event.target
  if (target instanceof HTMLSelectElement) chosen.value = target.value
}
</script>

<template>
  <section
    v-if="currentRun && shown"
    class="lb8-section"
    :aria-label="t('lb08.log.title')"
    data-testid="run-log"
  >
    <h2>{{ t('lb08.log.title') }}</h2>
    <div
      v-if="chain.length > 1"
      class="lb8-field"
    >
      <label for="lb08-log-run">{{ t('lb08.log.which') }}</label>
      <select
        id="lb08-log-run"
        class="lb8-control pick"
        :value="shown.id"
        @change="choose"
      >
        <option
          v-for="(run, index) in chain"
          :key="run.id"
          :value="run.id"
        >
          {{ runName(index, run.replayOf !== null) }}
        </option>
      </select>
    </div>
    <div
      class="lb8-table-wrap"
      role="region"
      tabindex="0"
      :aria-label="t('lb08.log.label')"
    >
      <table class="lb8-table">
        <caption class="lb-sr-only">
          {{ t('lb08.log.label') }}
        </caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('lb08.log.columns.number') }}
            </th>
            <th scope="col">
              {{ t('lb08.log.columns.time') }}
            </th>
            <th scope="col">
              {{ t('lb08.log.columns.event') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="event in shown.events"
            :key="event.seq"
            data-testid="log-event"
            :data-type="event.type"
          >
            <td class="lb8-nums lb8-mono">
              {{ event.seq }}
            </td>
            <td class="lb8-nums lb8-mono">
              {{ timeOf(event.at) }}
            </td>
            <td>
              {{ sentenceFor(event, { graph: runGraph, words }) }}
              <span
                v-if="!brief"
                class="lb8-mono type"
                lang="en"
              >{{ event.type }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.pick {
  width: auto;
  min-width: 160px;
  padding-block: 4px;
}

.type {
  display: block;
  font-size: 11px;
  color: var(--lb-graphite);
}
</style>
