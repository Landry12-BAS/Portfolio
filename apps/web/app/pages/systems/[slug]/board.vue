<script setup lang="ts">
// A system's evaluation board page (/systems/lb-01/board, /cs/systems/lb-01/board): the live demo,
// kept with the datasheet it belongs to. The page finds the board in the registry and loads it on
// demand; a part with no board yet says so and links back to its datasheet. An unknown part
// number answers a real 404, as the datasheet does.
import { LbIcon } from '@lb/icons'
import { defineAsyncComponent } from 'vue'

import { findSystemIn } from '#shared/data/datasheets'
import { boardLinks, boardLoader } from '~/boards/registry'

// Key the page by path so moving between parts, or languages, builds a fresh page.
definePageMeta({ key: route => route.path })

const { t } = useI18n()
const route = useRoute()
const localePath = useLocalePath()
const locale = useLocaleCode()

const slug = String(route.params.slug)
const system = findSystemIn(slug, locale.value)
if (!system) {
  throw createError({ statusCode: 404, statusMessage: 'Part not found' })
}

useSeoMeta({
  title: t('boardPage.title', { name: system.name }),
  description: system.function,
})

// A board that can be installed as an app names its manifest here, in the page's head.
useHead({ link: boardLinks(slug, locale.value) })

// The board is loaded on demand, and only for a part that has one.
const loader = boardLoader(slug)
const Board = loader ? defineAsyncComponent(loader) : undefined

/** Builds the address of a run's permalink page in the visitor's language. */
function permalinkFor(runId: string): string {
  return localePath(`/runs/${runId}`)
}
</script>

<template>
  <article class="board-page">
    <header class="head">
      <NuxtLinkLocale
        :to="`/systems/${system.slug}`"
        class="back"
      >
        <LbIcon
          name="arrow-left"
          :size="16"
        />
        {{ t('boardPage.back') }}
      </NuxtLinkLocale>
      <h1>{{ system.part }} {{ system.name }}</h1>
      <p class="fn">
        {{ system.function }}
      </p>
    </header>

    <ReadingModeSwitch />

    <Board
      v-if="Board"
      :permalink-for="permalinkFor"
    />
    <div
      v-else
      class="missing"
    >
      <h2>{{ t('boardPage.missing') }}</h2>
      <p>{{ t('boardPage.missingText') }}</p>
    </div>
  </article>
</template>

<style scoped>
.board-page {
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

.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-self: start;
  font-size: 14px;
}

h1 {
  font-size: clamp(1.5rem, 1.2rem + 1.2vw, 2rem);
  font-weight: 800;
  font-stretch: 112%;
  line-height: 1.1;
}

.fn {
  max-width: 64ch;
}

.missing {
  display: grid;
  gap: 6px;
  padding: 16px;
  border: 1px dashed var(--lb-rule);
}

.missing h2 {
  font-size: 1.1rem;
}
</style>
