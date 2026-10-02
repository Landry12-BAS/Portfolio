<script setup lang="ts">
// <LayerLadder>: the six layers a query passes through, in the order it meets them, each with a
// plain statement of what it is and what it stops. After a question has been run it also says what
// each layer did to the last query: let it through, stopped it (naming the rule), cut its result, or
// never saw it because an earlier layer had stopped it. The states are read from the answer's own
// fields and written in words next to an icon, so they never depend on colour.
import { LbIcon } from '@lb/icons'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatCount } from '~/board-kit/format'

import { SQL_LAYERS } from '#shared/data/sql-safety'

import type { Limits } from '../schemas'
import type { LayerState, LayerVerdict } from '../verdict'

const props = defineProps<{
  /** What each layer did to the last query, or undefined before a question has been run. */
  verdicts: readonly LayerVerdict[] | undefined
  /** The limits the layers enforce, which the descriptions quote. */
  limits: Limits
  /** True when the last question never produced a query, so no layer saw anything. */
  noQuery: boolean
}>()

const { t, locale } = useI18n()

const rows = computed(() => SQL_LAYERS.map((layer, index) => ({
  layer,
  number: index + 1,
  verdict: props.verdicts?.find(item => item.layer === layer),
})))

/** Picks the icon for what a layer did. */
function iconFor(state: LayerState): 'success' | 'shield' | 'filter' | 'close' {
  switch (state) {
    case 'passed': return 'success'
    case 'stopped': return 'shield'
    case 'cut': return 'filter'
    default: return 'close'
  }
}
</script>

<template>
  <section
    class="ladder"
    :aria-label="t('lb05.layers.title')"
    data-testid="layers"
  >
    <h3 class="lb-label">
      {{ t('lb05.layers.title') }}
    </h3>
    <p
      v-if="noQuery"
      class="no-query"
      data-testid="layers-no-query"
    >
      {{ t('lb05.layers.noQuery') }}
    </p>
    <ol
      class="list"
      :aria-label="verdicts ? t('lb05.layers.verdictLabel') : t('lb05.layers.label')"
    >
      <li
        v-for="row in rows"
        :key="row.layer"
        class="layer"
        :data-layer="row.layer"
        :data-state="row.verdict?.state ?? 'idle'"
        data-testid="layer"
      >
        <span class="number">{{ row.number }}</span>
        <div class="body">
          <p class="name">
            {{ t(`lb05.layers.items.${row.layer}.name`) }}
          </p>
          <p class="what">
            {{ t(`lb05.layers.items.${row.layer}.what`, { rows: formatCount(limits.row_cap, locale), seconds: formatCount(limits.query_timeout_seconds, locale) }) }}
          </p>
        </div>
        <p
          v-if="row.verdict"
          class="verdict"
          data-testid="layer-verdict"
        >
          <LbIcon
            :name="iconFor(row.verdict.state)"
            :size="16"
            tone="mono"
          />
          <span class="state">{{ t(`lb05.layers.states.${row.verdict.state}`) }}</span>
          <span
            v-if="row.verdict.rule"
            class="rule"
          >{{ t(`lb05.rules.${row.verdict.rule}`) }}</span>
        </p>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.ladder {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.no-query {
  font-size: 13px;
  color: var(--lb-graphite);
}

.list {
  display: grid;
  padding: 0;
  margin: 0;
  list-style: none;
  border: 1px solid var(--lb-rule);
}

.layer {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 12px;
  align-items: start;
  padding: 10px 12px;
  border-bottom: 1px solid var(--lb-rule);
}

.layer:last-child {
  border-bottom: 0;
}

.number {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  font-family: var(--lb-font-mono);
  font-size: 12px;
  font-weight: 700;
  border: 1.5px solid var(--lb-ink);
}

.name {
  font-weight: 700;
}

.what {
  font-size: 13px;
  color: var(--lb-graphite);
}

.verdict {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
  grid-column: 2;
  font-size: 13px;
}

.state {
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.rule {
  font-size: 13px;
}

.layer[data-state="stopped"],
.layer[data-state="cut"] {
  background: var(--lb-shade);
  border-left: 4px solid var(--lb-signal);
}

.layer[data-state="not-reached"] .name,
.layer[data-state="not-reached"] .what {
  color: var(--lb-graphite);
}

.layer[data-state="not-reached"] .name {
  font-weight: 400;
}
</style>
