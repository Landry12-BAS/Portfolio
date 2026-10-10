<script setup lang="ts">
// <LbSpecTable>: a two-column datasheet table (parameter, value) with row headers, so
// screen readers announce each value with its parameter.
import type { SpecRow } from '../types/components'

defineProps<{
  rows: SpecRow[]
  /** Column headers, datasheet style: the parameter, then its value. */
  columns: [string, string]
  caption?: string
}>()
</script>

<template>
  <div class="lb-spec">
    <table>
      <caption v-if="caption">
        {{ caption }}
      </caption>
      <thead>
        <tr>
          <th scope="col">
            {{ columns[0] }}
          </th>
          <th
            scope="col"
            class="lb-spec__value"
          >
            {{ columns[1] }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.label"
        >
          <th scope="row">
            {{ row.label }}
          </th>
          <td class="lb-spec__value">
            {{ row.value }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.lb-spec {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  line-height: 1.35;
}

caption {
  caption-side: top;
  padding-bottom: 6px;
  text-align: left;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

thead th {
  padding: 7px 8px;
  text-align: left;
  vertical-align: bottom;
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
  padding: 7px 8px;
  vertical-align: top;
  border-bottom: 1px solid var(--lb-rule);
}

tbody th {
  font-weight: 400;
  text-align: left;
}

.lb-spec__value {
  text-align: right;
  font-family: var(--lb-font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
