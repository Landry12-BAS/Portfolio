<script setup lang="ts">
// <CatalogGuide>: the selection guide on the home page. Visitors filter the ten systems
// by back end and technique, like a parts distributor's search, and open a datasheet
// from the table. Filter buttons report their state with aria-pressed, and the count
// is announced politely when it changes.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'

import type { Backend, Technique } from '#shared/catalog'
import { BACKENDS, TECHNIQUES } from '#shared/catalog'
import { useCatalogStore } from '~/stores/catalog'

const { t } = useI18n()
const catalog = useCatalogStore()
const { backend, technique, filtered } = storeToRefs(catalog)
const datasheets = useDatasheets()

// The systems that pass the filters, in the visitor's language.
const visible = computed(() => catalog.visibleIn(datasheets.value))

// Each filter's buttons: "All" first, then every key with its label in this language.
const backendOptions = computed<[Backend | 'all', string][]>(() => [
  ['all', t('catalog.all')],
  ...BACKENDS.map((key): [Backend, string] => [key, t(`catalog.backends.${key}`)]),
])
const techniqueOptions = computed<[Technique | 'all', string][]>(() => [
  ['all', t('catalog.all')],
  ...TECHNIQUES.map((key): [Technique, string] => [key, t(`catalog.techniqueNames.${key}`)]),
])

/** Returns the pill style for a build phase: solid now, outline next, dashed last. */
function phaseVariant(phase: 1 | 2 | 3) {
  return phase === 1 ? 'solid' : phase === 3 ? 'dashed' : 'outline'
}

/** Returns a system's techniques as one line of labels in this language. */
function techniqueList(keys: readonly Technique[]) {
  return keys.map(key => t(`catalog.techniqueNames.${key}`)).join(' · ')
}
</script>

<template>
  <div class="guide">
    <div class="filters">
      <div
        class="fgroup"
        role="group"
        :aria-label="t('catalog.filterBackend')"
      >
        <span
          class="lb-label flabel"
          aria-hidden="true"
        >{{ t('catalog.backend') }}</span>
        <button
          v-for="[value, label] in backendOptions"
          :key="value"
          type="button"
          class="fchip"
          :aria-pressed="backend === value ? 'true' : 'false'"
          @click="backend = value"
        >
          {{ label }}
        </button>
      </div>
      <div
        class="fgroup"
        role="group"
        :aria-label="t('catalog.filterTechnique')"
      >
        <span
          class="lb-label flabel"
          aria-hidden="true"
        >{{ t('catalog.technique') }}</span>
        <button
          v-for="[value, label] in techniqueOptions"
          :key="value"
          type="button"
          class="fchip"
          :aria-pressed="technique === value ? 'true' : 'false'"
          @click="technique = value"
        >
          {{ label }}
        </button>
      </div>
      <div class="fstatus">
        <span
          class="fcount"
          aria-live="polite"
        >{{ t('catalog.showing', { visible: visible.length, total: datasheets.length }) }}</span>
        <button
          v-if="filtered"
          type="button"
          class="clear"
          @click="catalog.clear()"
        >
          {{ t('catalog.clear') }}
        </button>
      </div>
    </div>
    <div
      class="table-scroll"
      tabindex="0"
      role="region"
      :aria-label="t('catalog.region')"
    >
      <table>
        <caption class="lb-sr-only">
          {{ t('catalog.caption') }}
        </caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('catalog.part') }}
            </th>
            <th scope="col">
              {{ t('catalog.system') }}
            </th>
            <th scope="col">
              {{ t('catalog.visitorAction') }}
            </th>
            <th scope="col">
              {{ t('catalog.backend') }}
            </th>
            <th scope="col">
              {{ t('catalog.techniques') }}
            </th>
            <th scope="col">
              {{ t('catalog.phase') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="system in visible"
            :key="system.part"
          >
            <td class="pn">
              <NuxtLinkLocale :to="`/systems/${system.slug}`">
                {{ system.part }}
              </NuxtLinkLocale>
            </td>
            <td class="sys">
              <LbIcon
                :name="system.icon"
                :size="18"
              />
              {{ system.name }}
              <span class="compact">
                <span class="compact-action">{{ system.visitorAction }}</span>
                <span class="compact-meta"><span class="compact-runtime">{{ system.runtime }}</span> · {{ techniqueList(system.techniques) }}</span>
              </span>
            </td>
            <td>{{ system.visitorAction }}</td>
            <td class="be">
              {{ system.runtime }}
            </td>
            <td class="tech">
              {{ techniqueList(system.techniques) }}
            </td>
            <td>
              <LbPill :variant="phaseVariant(system.phase)">
                {{ system.phase }}
              </LbPill>
            </td>
          </tr>
          <tr v-if="visible.length === 0">
            <td
              colspan="6"
              class="empty"
            >
              {{ t('catalog.empty') }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: grid;
  gap: 10px;
  margin-bottom: 18px;
}

.fgroup {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.flabel {
  min-width: 88px;
}

.fchip {
  padding: 7px 10px;
  font: 500 12.5px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
  border-radius: 3px;
  cursor: pointer;
}

.fchip:hover {
  border-color: var(--lb-ink);
}

.fchip[aria-pressed="true"] {
  color: var(--lb-sheet);
  background: var(--lb-ink);
  border-color: var(--lb-ink);
}

.fstatus {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  min-height: 20px;
}

.fcount {
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  color: var(--lb-graphite);
}

.clear {
  padding: 0;
  font: 500 13px/1.3 var(--lb-font-sans);
  color: var(--lb-signal);
  text-decoration: underline;
  text-underline-offset: 3px;
  background: none;
  border: 0;
  cursor: pointer;
}

.table-scroll {
  container: catalog / inline-size;
  overflow-x: auto;
  border-top: 1.5px solid var(--lb-ink);
}

table {
  width: 100%;
  min-width: 920px;
  border-collapse: collapse;
  font-size: 14px;
  line-height: 1.4;
}

th {
  padding: 8px 10px;
  text-align: left;
  font-family: var(--lb-font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: var(--lb-shade);
  border-bottom: 1.5px solid var(--lb-ink);
}

td {
  padding: 11px 10px;
  vertical-align: top;
  border-bottom: 1px solid var(--lb-rule);
}

.pn a {
  font-family: var(--lb-font-mono);
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
  text-decoration: none;
}

.pn a:hover {
  text-decoration: underline;
}

.sys {
  font-weight: 700;
  white-space: nowrap;
}

.sys .lb-icon {
  margin-right: 8px;
  vertical-align: -3px;
}

.be {
  white-space: nowrap;
}

.tech {
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.empty {
  font-style: italic;
  color: var(--lb-graphite);
}

/* What the compact table shows under a system's name, where the six columns don't fit. */
.compact {
  display: none;
}

/* Narrower than the full table (a phone, a tablet, a narrow window): two columns, and what a visitor
   does, the back end and the techniques under each name, rather than four columns hidden behind a
   sideways scroll that nothing points to. The filters above still choose by back end and technique. */
@container catalog (max-width: 919px) {
  table {
    min-width: 0;
  }

  th:nth-child(n + 3),
  td:nth-child(n + 3) {
    display: none;
  }

  .sys {
    white-space: normal;
  }

  .compact {
    display: block;
    margin-top: 4px;
    font-weight: 400;
  }

  .compact-action,
  .compact-meta {
    display: block;
  }

  .compact-meta {
    margin-top: 2px;
    font-size: 12.5px;
    color: var(--lb-graphite);
  }

  .compact-runtime {
    font-weight: 600;
  }
}
</style>
