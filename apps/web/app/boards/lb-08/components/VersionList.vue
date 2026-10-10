<script setup lang="ts">
// <VersionList>: the versions the workflow has had. Every save is a new version and none is ever
// changed, so a run stays tied to the exact graph it ran. Each row says how the version came to be: a
// hand-written sample, the model (with the number of calls it took and a link to the trace of that
// description), or the visitor's own edit.
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

import { formatMoment } from '~/board-kit/format'

import { useLb08Store } from '../store'

defineProps<{
  /** Builds the address of a run's permalink page in the visitor's language. */
  permalinkFor: (runId: string) => string
}>()

const { t, locale } = useI18n()
const { workflow } = storeToRefs(useLb08Store())
</script>

<template>
  <section
    class="lb8-panel"
    :aria-label="t('lb08.versions.title')"
    data-testid="versions"
  >
    <h3>{{ t('lb08.versions.title') }}</h3>
    <p
      v-if="!workflow"
      class="lb8-hint"
    >
      {{ t('lb08.versions.empty') }}
    </p>
    <div
      v-else
      class="lb8-table-wrap"
      role="region"
      tabindex="0"
      :aria-label="t('lb08.versions.title')"
    >
      <table class="lb8-table">
        <caption class="lb-sr-only">
          {{ t('lb08.versions.title') }}
        </caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('lb08.versions.columns.version') }}
            </th>
            <th scope="col">
              {{ t('lb08.versions.columns.origin') }}
            </th>
            <th scope="col">
              {{ t('lb08.versions.columns.when') }}
            </th>
            <th scope="col">
              {{ t('lb08.versions.columns.calls') }}
            </th>
            <th scope="col">
              {{ t('lb08.versions.columns.trace') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="version in workflow.versions"
            :key="version.version"
            data-testid="version"
          >
            <th scope="row">
              {{ version.version }}
              <span
                v-if="version.version === workflow.version"
                class="lb8-chip lb8-chip--board"
              >{{ t('lb08.versions.current') }}</span>
            </th>
            <td>{{ t(`lb08.versions.origins.${version.origin}`) }}</td>
            <td class="lb8-nums">
              {{ formatMoment(version.createdAt, locale) }}
            </td>
            <td class="lb8-nums">
              {{ version.modelCalls }}
            </td>
            <td>
              <NuxtLink
                v-if="version.traceRunId"
                :to="permalinkFor(version.traceRunId)"
              >
                {{ t('lb08.versions.openTrace') }}
              </NuxtLink>
              <template v-else>
                {{ t('lb08.versions.noTrace') }}
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
