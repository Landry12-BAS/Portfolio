<script setup lang="ts">
// <SemanticBrowser>: the semantic layer, which is everything the model is told about the data and so
// everything a query may use: the metrics (with the exact definition a question that names one is
// given), the ways to slice them, the tables and their columns, the joins that are allowed, and the date
// phrases the question resolver understands. Each part is a list a visitor can open one item of at a
// time, with the keyboard, and every definition is shown as SQL text. It also says what the layer
// leaves out on purpose, which is what the safety demo asks for.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatDay } from '~/board-kit/format'

import type { SemanticLayer } from '../schemas'

import SqlBlock from './SqlBlock.vue'

const props = defineProps<{
  layer: SemanticLayer | undefined
  status: 'idle' | 'loading' | 'ready' | 'failed'
}>()

const emit = defineEmits<{ retry: [] }>()

const { t, locale } = useI18n()

/** The parts of the layer the browser lists. */
type Part = 'metrics' | 'dimensions' | 'tables' | 'joins' | 'ranges'

const part = ref<Part>('metrics')
const options = computed(() => (['metrics', 'dimensions', 'tables', 'joins', 'ranges'] as const).map(value => ({ value, label: t(`lb05.semantic.parts.${value}`) })))

/** Counts the items of a part. */
function count(which: Part): number {
  return props.layer?.[which].length ?? 0
}

/** Writes a list of names for a sentence, such as the tables a metric needs. */
function list(items: readonly string[]): string {
  return items.join(', ')
}

/** Writes a day in the visitor's language. */
function day(iso: string): string {
  return formatDay(iso, locale.value)
}
</script>

<template>
  <section
    class="semantic"
    :aria-label="t('lb05.semantic.title')"
    data-testid="semantic"
  >
    <h2 class="lb-label">
      {{ t('lb05.semantic.title') }}
    </h2>
    <p class="intro">
      {{ t('lb05.semantic.intro') }}
    </p>

    <p
      v-if="status === 'loading' || status === 'idle'"
      class="note"
      role="status"
    >
      {{ t('lb05.semantic.loading') }}
    </p>
    <div
      v-else-if="status === 'failed' || !layer"
      class="note"
      role="status"
      data-testid="semantic-failed"
    >
      <p>{{ t('lb05.semantic.failed') }}</p>
      <button
        type="button"
        class="button"
        @click="emit('retry')"
      >
        {{ t('lb05.semantic.retry') }}
      </button>
    </div>

    <template v-else>
      <LbSegmented
        v-model="part"
        :options="options"
        :label="t('lb05.semantic.groupLabel')"
      />
      <p class="count">
        {{ t('lb05.semantic.count', { count: count(part) }) }}
      </p>

      <div
        v-if="part === 'metrics'"
        class="list"
        data-testid="semantic-metrics"
      >
        <p class="help">
          {{ t('lb05.semantic.metricsHelp') }}
        </p>
        <details
          v-for="metric in layer.metrics"
          :key="metric.name"
          class="item"
          data-testid="semantic-metric"
        >
          <summary>
            <span class="label">{{ metric.label }}</span>
            <span class="code">{{ metric.name }}</span>
            <span class="kind">{{ t(`lb05.semantic.kinds.${metric.kind}`) }}</span>
          </summary>
          <div class="detail">
            <p lang="en">
              {{ metric.description }}
            </p>
            <p class="small-label">
              {{ metric.kind === 'expression' ? t('lb05.semantic.definition') : t('lb05.semantic.workedExample') }}
            </p>
            <SqlBlock
              :sql="metric.definition"
              :label="t('lb05.semantic.definition')"
            />
            <p class="small">
              <span class="small-label">{{ t('lb05.semantic.needs') }}</span>
              <span class="code">{{ list(metric.needs) }}</span>
            </p>
            <p
              v-if="metric.synonyms.length > 0"
              class="small"
            >
              <span class="small-label">{{ t('lb05.semantic.alsoCalled') }}</span>
              <span lang="en">{{ list(metric.synonyms) }}</span>
            </p>
          </div>
        </details>
      </div>

      <div
        v-else-if="part === 'dimensions'"
        class="list"
        data-testid="semantic-dimensions"
      >
        <p class="help">
          {{ t('lb05.semantic.dimensionsHelp') }}
        </p>
        <details
          v-for="dimension in layer.dimensions"
          :key="dimension.name"
          class="item"
          data-testid="semantic-dimension"
        >
          <summary>
            <span class="label code">{{ dimension.name }}</span>
          </summary>
          <div class="detail">
            <p lang="en">
              {{ dimension.description }}
            </p>
            <p class="small-label">
              {{ t('lb05.semantic.expression') }}
            </p>
            <SqlBlock
              :sql="dimension.expression"
              :label="t('lb05.semantic.expression')"
            />
            <p class="small">
              <span class="small-label">{{ t('lb05.semantic.needs') }}</span>
              <span class="code">{{ list(dimension.needs) }}</span>
            </p>
            <p
              v-if="dimension.synonyms.length > 0"
              class="small"
            >
              <span class="small-label">{{ t('lb05.semantic.alsoCalled') }}</span>
              <span lang="en">{{ list(dimension.synonyms) }}</span>
            </p>
          </div>
        </details>
      </div>

      <div
        v-else-if="part === 'tables'"
        class="list"
        data-testid="semantic-tables"
      >
        <p class="help">
          {{ t('lb05.semantic.tablesHelp') }}
        </p>
        <details
          v-for="table in layer.tables"
          :key="table.name"
          class="item"
          data-testid="semantic-table"
        >
          <summary>
            <span class="label code">{{ table.name }}</span>
            <span class="kind">{{ t('lb05.semantic.count', { count: table.columns.length }) }}</span>
          </summary>
          <div class="detail">
            <p lang="en">
              {{ table.description }}
            </p>
            <div
              class="scroll"
              role="region"
              tabindex="0"
              :aria-label="`${t('lb05.semantic.columns')}: ${table.name}`"
            >
              <table>
                <caption class="lb-sr-only">
                  {{ t('lb05.semantic.columns') }}: {{ table.name }}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {{ t('lb05.semantic.columnName') }}
                    </th>
                    <th scope="col">
                      {{ t('lb05.semantic.columnType') }}
                    </th>
                    <th scope="col">
                      {{ t('lb05.semantic.columnAbout') }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="column in table.columns"
                    :key="column.name"
                  >
                    <th
                      scope="row"
                      class="code"
                    >
                      {{ column.name }}
                    </th>
                    <td class="code">
                      {{ column.type }}
                    </td>
                    <td lang="en">
                      {{ column.description }}
                      <span
                        v-if="column.values.length > 0"
                        class="values"
                      >{{ t('lb05.semantic.values') }}: {{ list(column.values.map(String)) }}</span>
                      <span
                        v-if="column.nullable"
                        class="values"
                      >{{ t('lb05.semantic.nullable') }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </details>
      </div>

      <div
        v-else-if="part === 'joins'"
        class="list"
        data-testid="semantic-joins"
      >
        <p class="help">
          {{ t('lb05.semantic.joinsHelp') }}
        </p>
        <ul class="joins">
          <li
            v-for="join in layer.joins"
            :key="`${join.left}=${join.right}`"
            class="code"
          >
            {{ join.left }} = {{ join.right }}
          </li>
        </ul>
      </div>

      <div
        v-else
        class="list"
        data-testid="semantic-ranges"
      >
        <p class="help">
          {{ t('lb05.semantic.rangesHelp') }}
        </p>
        <p class="small">
          {{ t('lb05.semantic.asOf', { date: day(layer.as_of) }) }}
        </p>
        <div
          class="scroll"
          role="region"
          tabindex="0"
          :aria-label="t('lb05.semantic.parts.ranges')"
        >
          <table>
            <caption class="lb-sr-only">
              {{ t('lb05.semantic.parts.ranges') }}
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  {{ t('lb05.semantic.phrase') }}
                </th>
                <th scope="col">
                  {{ t('lb05.semantic.from') }}
                </th>
                <th scope="col">
                  {{ t('lb05.semantic.to') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="range in layer.ranges"
                :key="range.name"
              >
                <th
                  scope="row"
                  lang="en"
                >
                  {{ range.label }}
                </th>
                <td>{{ day(range.start) }}</td>
                <td>{{ day(range.end) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p
        class="hidden"
        data-testid="semantic-hidden"
      >
        {{ t('lb05.semantic.hidden') }}
      </p>
    </template>
  </section>
</template>

<style scoped>
.semantic {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.intro,
.help,
.count,
.hidden {
  font-size: 13.5px;
  color: var(--lb-graphite);
}

.note {
  display: grid;
  gap: 8px;
  justify-items: start;
  font-size: 14px;
}

.list {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.item {
  border: 1px solid var(--lb-rule);
}

.item[open] {
  border-color: var(--lb-ink);
}

summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: baseline;
  padding: 8px 12px;
  cursor: pointer;
}

.label {
  font-weight: 700;
}

.code {
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
}

.kind {
  margin-left: auto;
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.detail {
  display: grid;
  gap: 8px;
  padding: 4px 12px 12px;
  font-size: 13.5px;
}

.small {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 13px;
}

.small-label {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--lb-graphite);
}

.scroll {
  overflow: auto;
  border: 1px solid var(--lb-rule);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

th,
td {
  padding: 5px 10px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--lb-rule);
}

thead th {
  background: var(--lb-shade);
}

.values {
  display: block;
  font-family: var(--lb-font-mono);
  font-size: 11.5px;
  color: var(--lb-graphite);
}

.joins {
  display: grid;
  gap: 4px;
  padding: 0;
  margin: 0;
  list-style: none;
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
  background: var(--lb-shade);
}
</style>
