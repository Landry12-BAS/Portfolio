<script setup lang="ts">
// <BoardScopePanel>: the Scope, the trace of the run on the board. It lists every step, tool call
// and model call with where it sits in the run, its model and tokens and how long it took, as a
// table a screen reader can read row by row (the bars are decoration; the numbers are the data),
// and it fills in as the run goes on, or at its end where the back end names a run only then. Only
// metadata is ever here: names, timings, models, counts.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatCount, formatDuration } from '~/board-kit/format'
import type { TimelineRow } from '~/board-kit/timeline'
import { useScopeStore } from '~/stores/scope'

const props = defineProps<{
  /** The Brief reading shows the summary and leaves out the table. */
  brief: boolean
  /** The localized path of this run's permalink page, for a live run. A replay has none, since its run has expired. */
  permalink?: string
}>()

const { t, locale } = useI18n()
const scope = useScopeStore()
const { phase, replayed, timeline, runId } = storeToRefs(scope)

const hasRows = computed(() => timeline.value.rows.length > 0)
const stateKey = computed(() => {
  if (phase.value === 'idle') return undefined
  if (phase.value === 'finished' && replayed.value) return 'board.scope.recorded'
  return `board.scope.${phase.value}`
})

// Copying a link needs the clipboard, which only a browser has, and only on a secure page.
const canCopy = ref(false)
const copied = ref(false)
onMounted(() => {
  canCopy.value = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
})

/** Copies the absolute address of this run's permalink page. */
async function copyLink(): Promise<void> {
  if (!props.permalink) return
  try {
    await navigator.clipboard.writeText(new URL(props.permalink, window.location.origin).href)
    copied.value = true
  }
  catch {
    copied.value = false
  }
}

/** Writes a row's duration. */
function duration(row: TimelineRow): string {
  return formatDuration(row.durationMs, locale.value)
}

/** Writes a model call's tokens, such as "410 in, 51 out"; empty for anything that is not a model call. */
function tokens(row: TimelineRow): string {
  if (row.inputTokens === undefined && row.outputTokens === undefined) return ''
  return t('board.scope.tokens', { input: formatCount(row.inputTokens ?? 0, locale.value), output: formatCount(row.outputTokens ?? 0, locale.value) })
}
</script>

<template>
  <section
    class="scope"
    :aria-label="t('board.scope.title')"
    data-testid="scope"
  >
    <header class="head">
      <h2 class="lb-label">
        {{ t('board.scope.title') }}
      </h2>
      <p
        class="state"
        role="status"
      >
        <template v-if="stateKey">
          <LbIcon
            :name="phase === 'following' || phase === 'waiting' ? 'trace' : phase === 'finished' ? 'success' : 'warning'"
            :size="16"
            tone="mono"
          />
          {{ t(stateKey) }}
        </template>
      </p>
    </header>

    <p
      v-if="phase === 'idle'"
      class="empty"
    >
      {{ t('board.scope.idle') }}
    </p>

    <p
      v-else-if="phase === 'waiting'"
      class="empty"
    >
      {{ t('board.scope.waitingText') }}
    </p>

    <dl
      v-if="hasRows"
      class="summary"
    >
      <div>
        <dt>{{ t('board.scope.steps') }}</dt>
        <dd>{{ formatCount(timeline.summary.steps, locale) }}</dd>
      </div>
      <div>
        <dt>{{ t('board.scope.modelCalls') }}</dt>
        <dd>{{ formatCount(timeline.summary.modelCalls, locale) }}</dd>
      </div>
      <div>
        <dt>{{ timeline.open ? t('board.scope.timeSoFar') : t('board.scope.time') }}</dt>
        <dd>{{ formatDuration(timeline.totalMs, locale) }}</dd>
      </div>
    </dl>

    <p
      v-if="hasRows && !brief"
      class="scroll-hint"
      aria-hidden="true"
    >
      {{ t('board.scope.scrollHint') }}
    </p>
    <div
      v-if="hasRows && !brief"
      class="scroll"
      role="region"
      tabindex="0"
      :aria-label="t('board.scope.tableLabel')"
    >
      <table>
        <caption class="lb-sr-only">
          {{ t('board.scope.caption') }}
        </caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('board.scope.columns.step') }}
            </th>
            <th scope="col">
              {{ t('board.scope.columns.time') }}
            </th>
            <th scope="col">
              {{ t('board.scope.columns.kind') }}
            </th>
            <th scope="col">
              {{ t('board.scope.columns.model') }}
            </th>
            <th scope="col">
              {{ t('board.scope.columns.tokens') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in timeline.rows"
            :key="row.span.spanId"
            data-testid="scope-row"
            :data-kind="row.kind"
          >
            <th
              scope="row"
              :style="{ paddingInlineStart: `${8 + row.depth * 14}px` }"
            >
              <span class="name">{{ row.span.name }}</span>
              <span
                v-if="row.parentName"
                class="lb-sr-only"
              >{{ t('board.scope.inside', { parent: row.parentName }) }}</span>
              <span
                v-if="row.span.status !== 'ok'"
                class="problem"
              >{{ t(`board.scope.status.${row.span.status}`) }}</span>
            </th>
            <td class="time">
              <span
                class="track"
                aria-hidden="true"
              >
                <span
                  class="bar"
                  :class="`bar--${row.kind}`"
                  :style="{ left: `${row.left * 100}%`, width: `${row.width * 100}%` }"
                />
              </span>
              <span class="mono">{{ duration(row) }}</span>
            </td>
            <td>
              <span
                class="swatch"
                :class="`swatch--${row.kind}`"
                aria-hidden="true"
              />
              {{ t(`board.scope.kinds.${row.kind}`) }}
            </td>
            <td class="mono">
              {{ row.model ?? '' }}
            </td>
            <td class="mono">
              {{ tokens(row) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="permalink && runId && phase !== 'idle'"
      class="links"
    >
      <NuxtLink
        :to="permalink"
        class="link"
      >
        <LbIcon
          name="arrow-up-right"
          :size="16"
        />
        {{ t('board.scope.permalink') }}
      </NuxtLink>
      <button
        v-if="canCopy"
        type="button"
        class="copy"
        @click="copyLink"
      >
        <LbIcon
          name="copy"
          :size="16"
          tone="mono"
        />
        {{ t('board.scope.copy') }}
      </button>
      <span
        class="copied"
        role="status"
      >{{ copied ? t('board.scope.copied') : '' }}</span>
    </div>
  </section>
</template>

<style scoped>
.scope {
  container: scope / inline-size;
  display: grid;
  gap: 10px;
  min-width: 0;
}

/* On a narrow frame the table scrolls sideways (below), and nothing else would say so: the time column
   ends at the frame's edge as if it were the last. The hint is visual; a screen reader reads the table
   by its columns and needs no scrolling. */
.scroll-hint {
  display: none;
  margin: 0;
  font-size: 12px;
  color: var(--lb-graphite);
}

@container scope (max-width: 720px) {
  .scroll-hint {
    display: block;
  }
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.empty {
  font-size: 14px;
  color: var(--lb-graphite);
}

.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin: 0;
}

.summary div {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.summary dt {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.summary dd {
  margin: 0;
  font-family: var(--lb-font-mono);
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.scroll {
  overflow-x: auto;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}

/* As wide as its content, and no narrower than its frame: squeezed into a phone's width, the one column that may
   wrap (the step's name) took all the squeeze and broke model names in the middle of a word. The frame scrolls
   sideways instead, and the name and the time still come first. */
table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  line-height: 1.35;
}

thead th {
  padding: 6px 8px;
  text-align: left;
  font-family: var(--lb-font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: var(--lb-shade);
  border-bottom: 1.5px solid var(--lb-ink);
}

tbody th,
tbody td {
  padding: 5px 8px;
  vertical-align: middle;
  text-align: left;
  font-weight: 400;
  border-bottom: 1px solid var(--lb-rule);
}

/* A very long name wraps instead of pushing the time out of a phone's first screen: the step and its
   time come first, and the rest (kind, model, tokens) is a swipe away. */
tbody th {
  min-width: 150px;
  max-width: 260px;
  overflow-wrap: anywhere;
}

/* On a phone the name gets less, so that the time is on the first screen beside it; a name still breaks at its
   hyphens and slashes first. */
@media (max-width: 640px) {
  tbody th {
    max-width: 12.5rem;
  }
}

tbody td {
  white-space: nowrap;
}

.name {
  font-family: var(--lb-font-mono);
  font-size: 11.5px;
}

.problem {
  margin-left: 8px;
  font-weight: 700;
}

.mono {
  font-family: var(--lb-font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 5px;
  border: 1.5px solid var(--lb-ink);
}

.swatch--run,
.bar--run {
  background: var(--lb-ink);
}

.swatch--step,
.bar--step {
  background: var(--lb-ch4);
}

.swatch--tool,
.bar--tool {
  background: var(--lb-ch2);
}

.swatch--model,
.bar--model {
  background: var(--lb-ch1);
}

.swatch--attempt,
.bar--attempt,
.swatch--other,
.bar--other {
  background: var(--lb-graphite);
}

.time {
  white-space: nowrap;
}

.track {
  position: relative;
  display: inline-block;
  width: 96px;
  height: 8px;
  margin-right: 8px;
  vertical-align: middle;
  background: var(--lb-shade);
}

.bar {
  position: absolute;
  top: 0;
  bottom: 0;
}

@media (max-width: 640px) {
  /* A shorter track keeps the step and its time on a phone's first screen. */
  .track {
    width: 56px;
  }

  tbody th {
    min-width: 120px;
  }
}

.links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  font-size: 13px;
}

/* The side column is tinted, and the signal blue of an ordinary link falls just short of 4.5:1 on that
   tint in the light theme, so links there take the ink colour (underlined by the base styles). */
.link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--lb-ink);
}

.copy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  font: 600 12px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.copy:hover {
  background: var(--lb-shade);
}
</style>
