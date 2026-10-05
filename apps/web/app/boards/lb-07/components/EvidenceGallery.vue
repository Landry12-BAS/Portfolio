<script setup lang="ts">
// <EvidenceGallery>: what the browser kept as evidence of a finished run: a screenshot after each step that
// made a finding (three at most) and one of the page at the end, each with a text alternative built from
// the step, the page and the engine, and the page's accessibility tree at the end as text. A live run's
// screenshots are pictures the site's own server answers (a PNG it has checked); a replay's are the
// recorded PNGs, checked in the browser before they are shown. A picture that cannot be shown says so.
import { storeToRefs } from 'pinia'
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EvidenceItem } from '../store'
import { useLb07Store } from '../store'
import { useLb07Words } from '../words'

defineProps<{
  /** The Brief reading leaves out the page's tree. */
  brief: boolean
}>()

const { t } = useI18n()
const words = useLb07Words()
const { run, report, evidence, evidenceStatus } = storeToRefs(useLb07Store())
const id = useId()

// The pictures that could not be loaded, by evidence id.
const broken = ref<ReadonlySet<string>>(new Set())

const screenshots = computed(() => evidence.value.filter(item => item.kind === 'screenshot'))
const trees = computed(() => evidence.value.filter(item => item.kind === 'snapshot'))

/** The step a piece of evidence was taken after, in words, when it is a step of the main pass. */
function stepWords(item: EvidenceItem): string | undefined {
  if (item.stepIndex === null) return undefined
  const step = run.value?.steps.find(candidate => candidate.index === item.stepIndex)
  return step ? words.stepText(step.step) : undefined
}

/** The caption under a screenshot. */
function captionOf(item: EvidenceItem): string {
  const step = stepWords(item)
  return step === undefined || item.stepIndex === null ? t('lb07.evidence.atEnd') : t('lb07.evidence.afterStep', { number: item.stepIndex + 1, step })
}

/** The text alternative of a screenshot: the step it was taken after, the page and the engine. */
function altOf(item: EvidenceItem): string {
  const engine = words.engineName(item.engine)
  const step = stepWords(item)
  if (step === undefined || item.stepIndex === null) return t('lb07.evidence.closingAlt', { engine })
  if (item.path === null) return t('lb07.evidence.screenshotAltNoPath', { number: item.stepIndex + 1, step, engine })
  return t('lb07.evidence.screenshotAlt', { path: item.path, number: item.stepIndex + 1, step, engine })
}

/** Notes a picture that could not be loaded, so its place says so instead of showing a broken image. */
function markBroken(item: EvidenceItem): void {
  broken.value = new Set([...broken.value, item.id])
}
</script>

<template>
  <section
    v-if="report && evidenceStatus !== 'idle'"
    class="lb7-panel"
    :aria-labelledby="`${id}-title`"
    data-testid="evidence"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb07.evidence.title') }}
    </h2>
    <p
      v-if="!brief"
      class="lb7-hint"
    >
      {{ t('lb07.evidence.intro') }}
    </p>
    <p
      v-if="evidenceStatus === 'loading'"
      class="lb7-hint"
    >
      {{ t('lb07.evidence.loading') }}
    </p>
    <p
      v-else-if="evidence.length === 0"
      class="lb7-hint"
      data-testid="no-evidence"
    >
      {{ t('lb07.evidence.none') }}
    </p>
    <ul
      v-if="screenshots.length > 0"
      class="gallery"
    >
      <li
        v-for="item in screenshots"
        :key="item.id"
        data-testid="screenshot"
      >
        <figure class="figure">
          <img
            v-if="item.src !== undefined && !broken.has(item.id)"
            class="picture"
            :src="item.src"
            :alt="altOf(item)"
            loading="lazy"
            decoding="async"
            @error="markBroken(item)"
          >
          <p
            v-else
            class="missing lb7-hint"
            data-testid="screenshot-missing"
          >
            {{ t('lb07.evidence.imageFailed') }}
          </p>
          <figcaption class="caption">
            {{ captionOf(item) }}
          </figcaption>
        </figure>
      </li>
    </ul>
    <template v-if="!brief">
      <details
        v-for="item in trees"
        :key="item.id"
        class="tree"
        data-testid="snapshot"
      >
        <summary>{{ t('lb07.evidence.tree') }}</summary>
        <pre
          class="tree-text"
          tabindex="0"
          lang="en"
          :aria-label="t('lb07.evidence.tree')"
        >{{ item.text }}</pre>
      </details>
    </template>
  </section>
</template>

<style scoped>
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
  gap: 12px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.figure {
  display: grid;
  gap: 6px;
  margin: 0;
}
.picture,
.missing {
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: contain;
  background: var(--lb-paper);
  border: 1px solid var(--lb-rule);
}
.missing {
  display: grid;
  place-items: center;
  padding: 8px;
  text-align: center;
  background: var(--lb-shade);
}
.caption {
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.tree summary {
  font-weight: 700;
  cursor: pointer;
}
.tree summary:focus-visible,
.tree-text:focus-visible {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}
.tree-text {
  max-height: 320px;
  padding: 10px 12px;
  margin: 8px 0 0;
  overflow: auto;
  font-family: var(--lb-font-mono);
  font-size: 11.5px;
  white-space: pre;
  background: var(--lb-shade);
}
</style>
