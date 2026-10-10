<script setup lang="ts">
// The permalink of one run (/runs/<id>, /cs/runs/<id>): the Scope's trace of a single run, for a
// link a visitor can share. Anyone who has the run's ID can read its trace, which holds names,
// timings, models and token counts only, never what was typed or answered, and which the
// platform deletes after 24 hours. A run that has none says so; an ID of the wrong shape is a 404.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { onBeforeUnmount, onMounted } from 'vue'

import { findSystemIn } from '#shared/data/datasheets'
import { useScopeStore } from '~/stores/scope'

// Key the page by path so moving between runs, or languages, builds a fresh page.
definePageMeta({ key: route => route.path })

// A run's ID, as the gateway and the site's server accept it.
const RUN_ID = /^[\w-]{8,64}$/

const { t } = useI18n()
const route = useRoute()
const locale = useLocaleCode()
const scope = useScopeStore()
const { spans } = storeToRefs(scope)

const runId = String(route.params.runId)
if (!RUN_ID.test(runId)) {
  throw createError({ statusCode: 404, statusMessage: 'Run not found' })
}

useSeoMeta({
  title: t('runs.title', { id: runId }),
  description: t('runs.lede'),
  // A trace is for whoever was sent its link, not for a search engine.
  robots: 'noindex',
})

// The system that ran it is named by its spans, once they arrive.
const system = computed(() => {
  const slug = spans.value[0]?.system
  return slug ? findSystemIn(slug, locale.value) : undefined
})

onMounted(() => scope.follow(runId))
onBeforeUnmount(() => scope.clear())
</script>

<template>
  <article class="run">
    <header class="head">
      <h1>{{ t('runs.heading') }}</h1>
      <p class="lede">
        {{ t('runs.lede') }}
      </p>
      <dl class="facts">
        <div>
          <dt>{{ t('runs.system') }}</dt>
          <dd v-if="system">
            <NuxtLinkLocale :to="`/systems/${system.slug}`">
              {{ system.part }} {{ system.name }}
            </NuxtLinkLocale>
          </dd>
          <dd v-else>
            {{ spans.length > 0 ? spans[0]?.system.toUpperCase() : '' }}
          </dd>
        </div>
        <div>
          <dt>{{ t('runs.runId') }}</dt>
          <dd class="mono">
            {{ runId }}
          </dd>
        </div>
      </dl>
    </header>

    <div class="trace">
      <BoardScopePanel :brief="false" />
    </div>

    <NuxtLinkLocale
      to="/"
      class="back"
    >
      <LbIcon
        name="arrow-left"
        :size="16"
      />
      {{ t('runs.back') }}
    </NuxtLinkLocale>
  </article>
</template>

<style scoped>
.run {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
}

.head {
  display: grid;
  gap: 8px;
  padding-top: 18px;
  border-top: 3px solid var(--lb-ink);
}

h1 {
  font-size: clamp(1.5rem, 1.2rem + 1.2vw, 2rem);
  font-weight: 800;
  font-stretch: 112%;
  line-height: 1.1;
}

.lede {
  max-width: 64ch;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 28px;
  margin: 4px 0 0;
}

.facts div {
  display: grid;
  gap: 2px;
}

.facts dt {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.facts dd {
  margin: 0;
}

.mono {
  font-family: var(--lb-font-mono);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.trace {
  padding: 16px;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}

.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-self: start;
  font-size: 14px;
}
</style>
