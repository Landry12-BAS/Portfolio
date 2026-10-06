<script setup lang="ts">
// <DocumentViewer>: the page of the document with the place of every field the reader found drawn over
// it. The picture is the one the service drew from the file (or a sample's own, in a replay); each field's
// box is four corners as shares of the page, drawn as a polygon on an SVG that covers the picture, so it
// follows the picture at any size. The field the visitor is looking at is lit: marked with the highlighter
// colour and a heavy outline, with its name, value and confidence written under the page. How sure the
// reader is of a box is said in words and a percentage and drawn with its own kind of line (solid for high,
// dashed for medium, dotted for low), never with colour alone. The overlay is a convenience for a pointer
// (a click on a box looks at its field); the table of fields beside it does everything the overlay does,
// from the keyboard, so the overlay is hidden from assistive technology.
import { LbIcon } from '@lb/icons'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { BAND_LINES, clampPage, confidencePercent, placedOnPage, polygonPoints } from '../boxes'
import type { Margin } from '../boxes'
import { fieldAt, fieldLabel } from '../fields'
import type { Field } from '../schemas'

/** How far outside its words a box is drawn, as a share of the page's width: a little under two pixels on a page of the usual size. */
const BOX_MARGIN = 0.004
/** The same for the box of the field in view, which has a heavier outline that must not lie on the letters. */
const LIT_MARGIN = 0.008
/** The width over the height of an A4 page, which a picture is taken to have until it is loaded and measured. */
const A4_SHAPE = 210 / 297

const props = defineProps<{
  /** The address of the picture of the page being shown. */
  pictureUrl: string
  /** The page being shown, from 1. */
  page: number
  /** How many pages the document has. */
  pages: number
  /** The document's fields, with their boxes. */
  fields: readonly Field[] | null
  /** The path of the field to light, if any. */
  selected: string | undefined
  /** The document's name, for the picture's description. */
  label: string
}>()

const emit = defineEmits<{
  page: [number]
  select: [path: string]
}>()

const { t } = useI18n()

// Whether every box is drawn, or only the lit one.
const showAll = ref(true)
// Whether the picture could not be loaded: the boxes are then not drawn over nothing.
const broken = ref(false)
// The width over the height of the picture, so that a margin is as many pixels above a box as beside it.
const shape = ref(A4_SHAPE)

watch(() => props.pictureUrl, () => {
  broken.value = false
})

const margin = computed<Margin>(() => ({ x: BOX_MARGIN, y: BOX_MARGIN * shape.value }))
const litMargin = computed<Margin>(() => ({ x: LIT_MARGIN, y: LIT_MARGIN * shape.value }))

/** Measures the picture once it is loaded. */
function measure(event: Event): void {
  const image = event.target
  if (image instanceof HTMLImageElement && image.naturalWidth > 0 && image.naturalHeight > 0) {
    shape.value = image.naturalWidth / image.naturalHeight
  }
}

const placed = computed(() => placedOnPage(props.fields, props.page))
// There is something for the toggle to switch only when a box was found on this page.
const hasBoxes = computed(() => placed.value.length > 0)
// An SVG paints in document order, so the lit box goes last to be on top of any box it overlaps.
const drawn = computed(() => placed.value
  .filter(item => showAll.value || item.path === props.selected)
  .toSorted((a, b) => Number(a.path === props.selected) - Number(b.path === props.selected)))
const field = computed(() => fieldAt(props.fields, props.selected))
const named = computed(() => (field.value === undefined ? undefined : fieldLabel(field.value.path, t)))
const alt = computed(() => t('lb03.viewer.pageAlt', { page: props.page, pages: props.pages, label: props.label }))

/** Says where a field is and how sure the reader is of it, in words. */
const where = computed(() => {
  // A document that failed after its pages were read has the page and no fields at all.
  if (props.fields === null) return t('lb03.viewer.noFields')
  const found = field.value
  if (found === undefined) return t('lb03.viewer.pickOne')
  if (found.box === null) return found.edited ? t('lb03.viewer.typed') : t('lb03.viewer.notFound')
  const band = t(`lb03.confidence.band.${found.box.band}`)
  return t('lb03.viewer.found', { page: found.box.page, band, percent: confidencePercent(found.box) })
})

/** Goes to another page of the document. */
function go(page: number): void {
  emit('page', clampPage(page, props.pages))
}
</script>

<template>
  <figure
    class="viewer"
    data-testid="viewer"
  >
    <div class="bar">
      <div
        v-if="pages > 1"
        class="pager"
        role="group"
        :aria-label="t('lb03.viewer.pages')"
      >
        <button
          type="button"
          class="button"
          :disabled="page <= 1"
          :aria-label="t('lb03.viewer.previous')"
          data-testid="previous-page"
          @click="go(page - 1)"
        >
          <LbIcon
            name="arrow-left"
            :size="16"
            tone="mono"
          />
        </button>
        <span
          class="page-of"
          data-testid="page-of"
        >{{ t('lb03.viewer.pageOf', { page, pages }) }}</span>
        <button
          type="button"
          class="button"
          :disabled="page >= pages"
          :aria-label="t('lb03.viewer.next')"
          data-testid="next-page"
          @click="go(page + 1)"
        >
          <LbIcon
            name="arrow-right"
            :size="16"
            tone="mono"
          />
        </button>
      </div>
      <label
        v-if="hasBoxes"
        class="toggle"
      >
        <input
          v-model="showAll"
          type="checkbox"
          data-testid="show-all"
        >
        <span>{{ t('lb03.viewer.showAll') }}</span>
      </label>
      <a
        v-if="!broken"
        class="full"
        :href="pictureUrl"
        target="_blank"
        rel="noopener"
        data-testid="open-page"
      >{{ t('lb03.viewer.openFull') }}</a>
    </div>

    <div class="sheet">
      <img
        class="page"
        :src="pictureUrl"
        :alt="alt"
        data-testid="page-picture"
        @load="measure"
        @error="broken = true"
      >
      <svg
        v-if="!broken"
        class="boxes"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <polygon
          v-for="item in drawn"
          :key="item.path"
          class="box"
          :class="[`line-${BAND_LINES[item.box.band]}`, { lit: item.path === selected }]"
          :points="polygonPoints(item.box.quad, item.path === selected ? litMargin : margin)"
          :data-path="item.path"
          :data-lit="item.path === selected ? 'true' : undefined"
          aria-hidden="true"
          data-testid="box"
          @click="emit('select', item.path)"
        />
      </svg>
      <p
        v-if="broken"
        class="broken"
        role="status"
        data-testid="picture-missing"
      >
        {{ t('lb03.viewer.missing') }}
      </p>
    </div>

    <figcaption
      class="caption"
      aria-live="polite"
      data-testid="viewer-caption"
    >
      <template v-if="field">
        <span class="name">{{ named }}</span>
        <span class="value">{{ field.value ?? t('lb03.fields.empty') }}</span>
      </template>
      <span class="where">{{ where }}</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.viewer {
  display: grid;
  gap: 8px;
  min-width: 0;
  margin: 0;
}

.bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
  justify-content: space-between;
}

.pager {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.button:hover:not(:disabled) {
  background: var(--lb-shade);
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.page-of {
  font-family: var(--lb-font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.toggle {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
}

.toggle input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--lb-board-mark);
}

.full {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  font-size: 13px;
}

/* The sheet is the picture and, over it, an SVG as big as the picture: the boxes are drawn in the page's own units. */
.sheet {
  position: relative;
  line-height: 0;
  background: var(--lb-shade);
  border: 1.5px solid var(--lb-rule);
}

.page {
  display: block;
  width: 100%;
  height: auto;
  min-height: 120px;
}

.boxes {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/* The picture is white paper in both themes, so the marks on it use the page tokens, which do not change with the theme. */
.box {
  fill: transparent;
  stroke: var(--lb-page-line);
  stroke-width: 1.5px;
  vector-effect: non-scaling-stroke;
  cursor: pointer;
  pointer-events: all;
}

/* The kind of line says how sure the reader is, so it can be told apart without colour. */
.box.line-dashed {
  stroke-dasharray: 6 3;
}

.box.line-dotted {
  stroke-dasharray: 1.5 3.5;
}

/* The lit box: the highlighter colour under a heavy outline, over every other box. */
.box.lit {
  fill: var(--lb-page-marker);
  fill-opacity: 0.5;
  stroke: var(--lb-page-ink);
  stroke-width: 2.5px;
}

.broken {
  padding: 24px 12px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--lb-graphite);
  text-align: center;
}

.caption {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  align-items: baseline;
  font-size: 13px;
}

.name {
  font-weight: 700;
}

.value {
  font-family: var(--lb-font-mono);
  overflow-wrap: anywhere;
}

.where {
  color: var(--lb-graphite);
}
</style>
