<script setup lang="ts">
// <RunProgress>: how a run is going, step by step. Each step shows its state in words and an icon,
// the attempts it has used out of three, and, when an attempt has failed and the queue is waiting
// to try again, a countdown to the next attempt that ticks while the page is open. A step that
// used every attempt says it is in the dead-letter queue. What a step produced, or why it was
// skipped or failed, is in its last column. The runs of the chain (a run and its replays) are
// listed above, and the changes worth hearing (a retry, a dead letter, the end) are said aloud.
// The same table serves a live run and the replay of a recording, since both are folds of events.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { iconFor, kindOf, statusIcon } from '../graph/visual'
import { outlineOf } from '../graph/outline'
import { wordsFrom } from '../graph/words'
import { retryLeftMs } from '../run/model'
import type { RunModel, StepRun } from '../run/model'
import { announcementsAfter, errorWords, secondsOf, valueWords } from '../run/narrate'
import { useLb08Store } from '../store'

defineProps<{
  /** The Brief reading leaves out the ids and the service's own error codes. */
  brief: boolean
}>()

const { t, te } = useI18n()
const store = useLb08Store()
const { chain, currentRun, runGraph } = storeToRefs(store)

const words = wordsFrom((key, params) => t(key, params), key => te(key))
const now = ref(Date.now())
const announced = ref('')
const announcedKey = ref(0)
let ticker: ReturnType<typeof setInterval> | undefined
let toldRun: string | undefined
let toldSeq = 0

const rows = computed(() => {
  const run = currentRun.value
  const graph = runGraph.value
  if (!run) return []
  const numbers = new Map(graph ? outlineOf(graph).map(item => [item.node.id, item.number]) : [])
  return run.steps
    .map(step => ({ step, node: graph?.nodes.find(candidate => candidate.id === step.nodeId), number: numbers.get(step.nodeId) ?? 0 }))
    .sort((a, b) => a.number - b.number)
})
const waiting = computed(() => currentRun.value?.steps.some(step => step.retry !== undefined) ?? false)

/** Moves the countdown on. */
function tick(): void {
  now.value = Date.now()
}

/** Stops the countdown's clock. */
function stopTicker(): void {
  if (ticker !== undefined) clearInterval(ticker)
  ticker = undefined
}

// The clock runs only while some step is waiting to try again.
watch(waiting, (on) => {
  stopTicker()
  if (!on || typeof window === 'undefined') return
  tick()
  ticker = setInterval(tick, 250)
}, { immediate: true })

onBeforeUnmount(stopTicker)

// What is worth saying aloud is said once, in the order it happened.
watch(() => [currentRun.value?.id, currentRun.value?.lastSeq] as const, () => {
  const run = currentRun.value
  if (!run) {
    toldRun = undefined
    toldSeq = 0
    announced.value = ''
    return
  }
  if (run.id !== toldRun) {
    toldRun = run.id
    toldSeq = 0
  }
  const texts = announcementsAfter(run.events, toldSeq, { graph: runGraph.value, words })
  toldSeq = run.lastSeq
  if (texts.length === 0) return
  announced.value = texts.join(' ')
  announcedKey.value += 1
}, { immediate: true })

/** A step's name. */
function nameOf(id: string, label: string | undefined): string {
  return label || id
}

/** The whole seconds until a step's next attempt. */
function secondsLeft(step: StepRun): number {
  return secondsOf(retryLeftMs(step, now.value))
}

/** The words for a name of a value a step produced. */
function valueName(name: string): string {
  const key = `lb08.values.${name}`
  return te(key) ? t(key) : name
}

/** The values a step produced, named and written for a reader. */
function produced(step: StepRun): { name: string, text: string }[] {
  return Object.entries(step.output ?? {}).map(([name, value]) => ({ name: valueName(name), text: valueWords(words, value) }))
}

/** A run of the chain in words: which run it is, and how it ended or how it is going. */
function chainWords(run: RunModel): string {
  const number = chain.value.findIndex(candidate => candidate.id === run.id) + 1
  const which = run.replayOf ? t('lb08.run.chainReplay', { number }) : t('lb08.run.chainRun', { number })
  return `${which}: ${t(`lb08.run.statuses.${run.status}`)}`
}
</script>

<template>
  <section
    class="lb8-section"
    :aria-label="t('lb08.steps.title')"
    data-testid="run-progress"
  >
    <h2>{{ t('lb08.steps.title') }}</h2>

    <p
      v-if="!currentRun"
      class="lb8-hint"
      data-testid="run-empty"
    >
      {{ t('lb08.run.nothingYet') }}
    </p>

    <template v-else>
      <div class="lb8-row head">
        <span
          class="lb8-chip lb8-chip--board"
          data-testid="run-status"
          :data-status="currentRun.status"
        >
          <LbIcon
            :name="statusIcon(currentRun.status)"
            :size="14"
            tone="mono"
          />
          {{ t(`lb08.run.statuses.${currentRun.status}`) }}
        </span>
        <span class="lb8-hint">{{ t('lb08.run.runOf', { version: currentRun.version }) }}</span>
        <span
          v-if="currentRun.replayOf"
          class="lb8-hint"
        >{{ t('lb08.run.replayOf') }}</span>
      </div>

      <div
        v-if="chain.length > 1"
        class="chain"
        data-testid="run-chain"
      >
        <span class="lb-label">{{ t('lb08.run.chain') }}</span>
        <ol class="chips">
          <li
            v-for="run in chain"
            :key="run.id"
            :aria-current="run.id === currentRun.id ? 'true' : undefined"
          >
            <span
              class="lb8-chip"
              :class="{ current: run.id === currentRun.id }"
            >
              {{ chainWords(run) }}
            </span>
          </li>
        </ol>
      </div>

      <div
        class="lb8-table-wrap"
        role="region"
        tabindex="0"
        :aria-label="t('lb08.steps.label')"
      >
        <table class="lb8-table">
          <caption class="lb-sr-only">
            {{ t('lb08.steps.label') }}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                {{ t('lb08.steps.columns.step') }}
              </th>
              <th scope="col">
                {{ t('lb08.steps.columns.status') }}
              </th>
              <th scope="col">
                {{ t('lb08.steps.columns.attempts') }}
              </th>
              <th scope="col">
                {{ t('lb08.steps.columns.result') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.step.nodeId"
              :data-step="row.step.nodeId"
              :data-status="row.step.status"
              data-testid="run-step"
            >
              <th scope="row">
                <span class="who">
                  <span class="lb8-mono number">{{ row.number }}</span>
                  <LbIcon
                    v-if="row.node"
                    :name="iconFor(row.node)"
                    :size="16"
                    tone="mono"
                  />
                  <span>
                    <strong>{{ nameOf(row.step.nodeId, row.node?.label) }}</strong>
                    <span
                      v-if="row.node"
                      class="lb8-hint kind"
                    >{{ t(`lb08.kinds.${kindOf(row.node)}`) }}</span>
                    <span
                      v-if="!brief"
                      class="lb8-hint lb8-mono kind"
                    >{{ row.step.nodeId }}</span>
                  </span>
                </span>
              </th>
              <td>
                <span class="state">
                  <LbIcon
                    :name="statusIcon(row.step.status)"
                    :size="16"
                    tone="mono"
                  />
                  <span data-testid="step-status">{{ t(`lb08.steps.statuses.${row.step.status}`) }}</span>
                </span>
                <span
                  v-if="row.step.retry"
                  class="lb8-hint block"
                  data-testid="retry-countdown"
                >
                  {{ secondsLeft(row.step) > 0 ? t('lb08.steps.retryIn', { seconds: secondsLeft(row.step) }) : t('lb08.steps.retryNow') }}
                </span>
                <span
                  v-if="row.step.deadLettered"
                  class="block dead"
                  data-testid="step-dead"
                >{{ t('lb08.steps.dead') }}</span>
              </td>
              <td class="lb8-nums">
                <template v-if="row.step.attempts > 0">
                  {{ t('lb08.steps.attemptsUsed', { attempts: row.step.attempts, max: row.step.maxAttempts }) }}
                </template>
                <template v-else-if="row.step.status === 'succeeded'">
                  {{ t('lb08.steps.noAttempts') }}
                </template>
                <template v-else>
                  <span aria-hidden="true">·</span>
                </template>
              </td>
              <td>
                <template v-if="row.step.status === 'skipped' && row.step.skipped">
                  {{ t(`lb08.steps.skipped.${row.step.skipped}`) }}
                </template>
                <template v-else-if="row.step.error">
                  {{ errorWords(words, row.step.error.code) }}
                  <span
                    v-if="!brief"
                    class="lb8-mono block"
                    lang="en"
                  >{{ row.step.error.code }}: {{ row.step.error.message }}</span>
                </template>
                <template v-else-if="row.step.status === 'succeeded'">
                  <span
                    v-if="produced(row.step).length === 0"
                    class="lb8-hint"
                  >{{ t('lb08.steps.noOutput') }}</span>
                  <ul
                    v-else
                    class="outputs"
                    :aria-label="t('lb08.steps.outputs')"
                  >
                    <li
                      v-for="item in produced(row.step)"
                      :key="item.name"
                    >
                      <span class="lb8-hint">{{ item.name }}:</span>
                      <span class="lb8-mono">{{ item.text }}</span>
                    </li>
                  </ul>
                </template>
                <template v-else-if="row.step.decision">
                  {{ t('lb08.steps.decided', { decision: t(`lb08.log.${row.step.decision}`) }) }}
                </template>
                <template v-else>
                  <span aria-hidden="true">·</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <p
      class="lb-sr-only"
      role="status"
      aria-live="polite"
      data-testid="run-announce"
    >
      <span :key="announcedKey">{{ announced }}</span>
    </p>
  </section>
</template>

<style scoped>
.head {
  align-items: center;
}

.chain {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.chips .current {
  background: var(--lb-board-tint);
  border: 1.5px solid var(--lb-ink);
}

.who {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.number {
  min-width: 14px;
  color: var(--lb-graphite);
}

.kind {
  display: block;
  font-size: 11.5px;
}

.state {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-weight: 600;
}

.block {
  display: block;
}

.dead {
  font-weight: 700;
}

.outputs {
  display: grid;
  gap: 2px;
  padding: 0;
  margin: 0;
  font-size: 12.5px;
  list-style: none;
}
</style>
