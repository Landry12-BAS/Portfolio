<script setup lang="ts">
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'

import { findSystem, systems } from '#shared/data/systems'
import type { ReadingMode } from '~/stores/reading'
import { useReadingStore } from '~/stores/reading'

// Key the page by path so moving between parts builds a fresh page for each one.
definePageMeta({ key: route => route.path })

const route = useRoute()
const system = findSystem(String(route.params.slug))
if (!system) {
  throw createError({ statusCode: 404, statusMessage: 'Part not found' })
}

useSeoMeta({
  title: `${system.part} ${system.name}`,
  description: system.function,
})

const { mode } = storeToRefs(useReadingStore())
const readingOptions: { value: ReadingMode, label: string }[] = [
  { value: 'technical', label: 'Technical' },
  { value: 'brief', label: 'Brief' },
]

const index = systems.findIndex(item => item.slug === system.slug)
const previous = systems[index - 1]
const next = systems[index + 1]
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
          Phase {{ system.phase }}
        </LbPill>
        <span class="meta-line">{{ system.runtime }} · Size {{ system.size }}</span>
      </div>
    </header>

    <div class="mode-row">
      <span
        class="lb-label"
        aria-hidden="true"
      >Reading mode</span>
      <LbSegmented
        v-model="mode"
        :options="readingOptions"
        label="Reading mode"
      />
    </div>

    <div
      class="part-body"
      :class="{ brief: mode === 'brief' }"
    >
      <div class="col">
        <div class="fld">
          <h2>Problem</h2>
          <p>{{ system.problem }}</p>
        </div>
        <div class="fld">
          <h2>Try it live</h2>
          <p>{{ system.tryIt }}</p>
        </div>
        <div class="fld">
          <h2>Proves</h2>
          <p>{{ system.proves }}</p>
        </div>
        <ul
          class="tags"
          aria-label="Techniques"
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
          <h2>Signal chain</h2>
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
          <h2>Stack</h2>
          <p class="stackline">
            {{ system.stack.join(' · ') }}
          </p>
        </div>
        <div class="fld">
          <h2>Engineering highlights</h2>
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
          :columns="['Operating limit', 'Value']"
          :rows="[...system.limits]"
        />
      </div>
    </div>

    <p class="status">
      <span class="lb-label">Status</span>
      In build, Phase {{ system.phase }}. The live demo, its evaluation board and the Scope
      open here when this part ships.
    </p>

    <nav
      class="pager"
      aria-label="Other parts"
    >
      <NuxtLink
        v-if="previous"
        :to="`/systems/${previous.slug}`"
        class="pager-link"
      >
        <LbIcon
          name="arrow-left"
          :size="16"
        />
        {{ previous.part }} {{ previous.name }}
      </NuxtLink>
      <NuxtLink
        to="/#systems"
        class="pager-link"
      >
        All systems
      </NuxtLink>
      <NuxtLink
        v-if="next"
        :to="`/systems/${next.slug}`"
        class="pager-link"
      >
        {{ next.part }} {{ next.name }}
        <LbIcon
          name="arrow-right"
          :size="16"
        />
      </NuxtLink>
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

.mode-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
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
