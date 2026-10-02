<script setup lang="ts">
// A system's datasheet page (/systems/lb-01, /cs/systems/lb-01): identity, the Brief or
// Technical reading, the operating limits, its build status, and links to the parts
// before and after it. An unknown part number answers a real 404.
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'

import { findSystemIn } from '#shared/data/datasheets'
import { hasBoard } from '~/boards/registry'
import { useReadingStore } from '~/stores/reading'

// Key the page by path so moving between parts, or languages, builds a fresh page.
definePageMeta({ key: route => route.path })

const { t } = useI18n()
const route = useRoute()
const locale = useLocaleCode()
const datasheets = useDatasheets()

const system = findSystemIn(String(route.params.slug), locale.value)
if (!system) {
  throw createError({ statusCode: 404, statusMessage: 'Part not found' })
}

useSeoMeta({
  title: `${system.part} ${system.name}`,
  description: system.function,
})

// The reading mode is shared with every datasheet and board, and remembered between visits.
const { mode } = storeToRefs(useReadingStore())
// A part whose evaluation board has shipped links to it, and says so in its status.
const board = hasBoard(system.slug)

// The parts before and after this one, for the pager at the bottom.
const index = datasheets.value.findIndex(item => item.slug === system.slug)
const previous = datasheets.value[index - 1]
const next = datasheets.value[index + 1]
const phaseVariant = system.phase === 1 ? 'solid' : system.phase === 3 ? 'dashed' : 'outline'
</script>

<template>
  <article
    v-if="system"
    class="part"
  >
    <header class="part-head">
      <div class="pn">
        <LbIcon
          :name="system.icon"
          :size="30"
        />
        <span>{{ system.part }}</span>
      </div>
      <div>
        <h1>{{ system.name }}</h1>
        <p class="fn">
          {{ system.function }}
        </p>
      </div>
      <div class="meta">
        <LbPill :variant="phaseVariant">
          {{ t('datasheet.phase', { n: system.phase }) }}
        </LbPill>
        <span class="meta-line">{{ system.runtime }} · {{ t('datasheet.size', { size: system.size }) }}</span>
      </div>
    </header>

    <ReadingModeSwitch />

    <div
      class="part-body"
      :class="{ brief: mode === 'brief' }"
    >
      <div class="col">
        <div class="fld">
          <h2>{{ t('datasheet.problem') }}</h2>
          <p>{{ system.problem }}</p>
        </div>
        <div class="fld">
          <h2>{{ t('datasheet.tryIt') }}</h2>
          <p>{{ system.tryIt }}</p>
        </div>
        <div class="fld">
          <h2>{{ t('datasheet.proves') }}</h2>
          <p>{{ system.proves }}</p>
        </div>
        <ul
          class="tags"
          :aria-label="t('datasheet.techniques')"
        >
          <li
            v-for="tag in system.tags"
            :key="tag"
          >
            {{ tag }}
          </li>
        </ul>
      </div>
      <div
        v-if="mode === 'technical'"
        class="col"
      >
        <div class="fld">
          <h2>{{ t('datasheet.chain') }}</h2>
          <ol class="chain">
            <li
              v-for="step in system.chain"
              :key="step"
            >
              <span>{{ step }}</span>
            </li>
          </ol>
        </div>
        <div class="fld">
          <h2>{{ t('datasheet.stack') }}</h2>
          <p class="stackline">
            {{ system.stack.join(' · ') }}
          </p>
        </div>
        <div class="fld">
          <h2>{{ t('datasheet.highlights') }}</h2>
          <ul class="hl">
            <li
              v-for="line in system.highlights"
              :key="line"
            >
              {{ line }}
            </li>
          </ul>
        </div>
        <LbSpecTable
          :columns="[t('datasheet.limit'), t('datasheet.value')]"
          :rows="[...system.limits]"
        />
      </div>
    </div>

    <p class="status">
      <span class="lb-label">{{ t('datasheet.status') }}</span>
      {{ board ? t('datasheet.boardOpen') : t('datasheet.statusText', { n: system.phase }) }}
      <NuxtLinkLocale
        v-if="board"
        :to="`/systems/${system.slug}/board`"
        class="board-link"
      >
        {{ t('datasheet.openBoard') }}
        <LbIcon
          name="arrow-right"
          :size="16"
        />
      </NuxtLinkLocale>
    </p>

    <nav
      class="pager"
      :aria-label="t('datasheet.otherParts')"
    >
      <NuxtLinkLocale
        v-if="previous"
        :to="`/systems/${previous.slug}`"
        class="pager-link"
      >
        <LbIcon
          name="arrow-left"
          :size="16"
        />
        {{ previous.part }} {{ previous.name }}
      </NuxtLinkLocale>
      <NuxtLinkLocale
        :to="{ path: '/', hash: '#systems' }"
        class="pager-link"
      >
        {{ t('datasheet.allSystems') }}
      </NuxtLinkLocale>
      <NuxtLinkLocale
        v-if="next"
        :to="`/systems/${next.slug}`"
        class="pager-link"
      >
        {{ next.part }} {{ next.name }}
        <LbIcon
          name="arrow-right"
          :size="16"
        />
      </NuxtLinkLocale>
    </nav>
  </article>
</template>

<style scoped>
.part {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 24px;
}

.part-head {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr) auto;
  gap: 8px 24px;
  align-items: start;
  padding-top: 18px;
  border-top: 3px solid var(--lb-ink);
}

.pn {
  display: grid;
  gap: 10px;
  justify-items: start;
  font-family: var(--lb-font-mono);
  font-size: 1.55rem;
  font-weight: 700;
  line-height: 1.15;
}

h1 {
  font-size: clamp(1.6rem, 1.2rem + 1.4vw, 2.2rem);
  font-weight: 800;
  font-stretch: 112%;
  line-height: 1.1;
}

.fn {
  max-width: 64ch;
  margin-top: 8px;
}

.meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  text-align: right;
}

.meta-line {
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  color: var(--lb-graphite);
  white-space: nowrap;
}

.part-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.18fr);
  gap: 30px;
}

.part-body.brief {
  grid-template-columns: minmax(0, 1fr);
}

.col {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
  align-content: start;
  min-width: 0;
}

.fld h2 {
  margin-bottom: 5px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.fld p {
  max-width: 64ch;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0;
  list-style: none;
}

.tags li {
  padding: 3px 7px;
  font-family: var(--lb-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--lb-graphite);
  border: 1px solid var(--lb-rule);
  border-radius: 2px;
}

.chain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 0;
  padding: 0;
  list-style: none;
}

.chain li {
  display: inline-flex;
  align-items: center;
}

.chain span {
  padding: 4px 7px;
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  font-stretch: 87.5%;
  line-height: 1.3;
  border: 1px solid var(--lb-ink);
  border-radius: 2px;
}

.chain li:not(:last-child)::after {
  padding-inline: 5px;
  font-size: 12px;
  color: var(--lb-graphite);
  content: "\2192";
}

.stackline {
  font-family: var(--lb-font-mono);
  font-size: 11.5px;
  font-stretch: 87.5%;
  line-height: 1.6;
}

.hl {
  display: grid;
  gap: 7px;
  padding-left: 1.1em;
  font-size: 15px;
}

.hl li::marker {
  color: var(--lb-signal);
}

.status {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  padding: 12px 14px;
  font-size: 14px;
  border: 1px dashed var(--lb-rule);
}

.board-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
}

.pager {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 10px 20px;
  padding-top: 14px;
  border-top: 1px solid var(--lb-rule);
}

.pager-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
}

@media (max-width: 760px) {
  .part-head,
  .part-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .meta {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    text-align: left;
  }
}
</style>
