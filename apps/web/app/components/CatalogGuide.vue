<script setup lang="ts">
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'

import type { Backend, Technique } from '#shared/catalog'
import { BACKENDS, TECHNIQUES } from '#shared/catalog'
import { useCatalogStore } from '~/stores/catalog'

const catalog = useCatalogStore()
const { backend, technique, visible, filtered } = storeToRefs(catalog)

const entries = <K extends string>(labels: Record<K, string>) =>
  Object.entries(labels) as [K, string][]

const backendOptions: [Backend | 'all', string][] = [['all', 'All'], ...entries(BACKENDS)]
const techniqueOptions: [Technique | 'all', string][] = [['all', 'All'], ...entries(TECHNIQUES)]

const phaseVariant = (phase: 1 | 2 | 3) => (phase === 1 ? 'solid' : phase === 3 ? 'dashed' : 'outline')
const techniqueList = (keys: readonly Technique[]) => keys.map(key => TECHNIQUES[key]).join(' · ')
</script>

<template>
  <div class="guide">
    <div class="filters">
      <div
        class="fgroup"
        role="group"
        aria-label="Filter by back end"
      >
        <span
          class="lb-label flabel"
          aria-hidden="true"
        >Back end</span>
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
        aria-label="Filter by technique"
      >
        <span
          class="lb-label flabel"
          aria-hidden="true"
        >Technique</span>
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
        >Showing {{ visible.length }} of {{ catalog.total }} systems</span>
        <button
          v-if="filtered"
          type="button"
          class="clear"
          @click="catalog.clear()"
        >
          Clear filters
        </button>
      </div>
    </div>
    <div
      class="table-scroll"
      tabindex="0"
      role="region"
      aria-label="Systems"
    >
      <table>
        <caption class="lb-sr-only">
          The ten systems with their back end, techniques and build phase
        </caption>
        <thead>
          <tr>
            <th scope="col">
              Part
            </th>
            <th scope="col">
              System
            </th>
            <th scope="col">
              What a visitor does
            </th>
            <th scope="col">
              Back end
            </th>
            <th scope="col">
              Techniques
            </th>
            <th scope="col">
              Phase
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="system in visible"
            :key="system.part"
          >
            <td class="pn">
              <NuxtLink :to="`/systems/${system.slug}`">
                {{ system.part }}
              </NuxtLink>
            </td>
            <td class="sys">
              <LbIcon
                :name="system.icon"
                :size="18"
              />
              {{ system.name }}
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
              No system matches both filters. Clear one of them to see more.
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
</style>
