<script setup lang="ts">
// <ContractViewer>: the contract's PDF, page by page, with the passages the report cites highlighted. It
// is loaded only when a visitor first asks to see a passage, and pdf.js (its worker and all) only once this
// is on the page. The PDF is drawn on a canvas from the bytes the board holds. A highlight is drawn over
// the exact characters a citation names: the browser's pdf.js reads each page's text with the same
// function the server does, and the viewer checks, page by page and in the background, that the two
// texts are identical before it draws a single box. Where they are not, the highlight is left off that
// page and the viewer says so; the passage stays available as text, marked, under every page. The viewer
// works from the keyboard (page buttons and a page number, and the page area scrolls), and a reader who
// cannot see the page has the page's text instead.
import { LbIcon } from '@lb/icons'
import type { Lb04Finding, PageText } from '@lb/contracts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { agreementOf, citationsOnPage } from '../highlight'
import type { PageAgreement } from '../highlight'
import type { DrawnPage, PdfDocument } from '../pdf/engine'
import type { ContractPage, Focus } from '../store'
import PageTextView from './PageTextView.vue'

const props = defineProps<{
  /** The contract's PDF. */
  pdf: Uint8Array
  /** The text of every page as the server extracted it, which every citation counts its characters in. */
  pages: readonly ContractPage[]
  findings: readonly Lb04Finding[]
  /** The latest request to show a finding's passage. */
  focus: Focus | undefined
  selectedId: string | undefined
}>()

const emit = defineEmits<{ select: [id: string] }>()

const { t } = useI18n()

/** The widest a page is drawn, in CSS pixels. */
const MAX_WIDTH = 760
/** The narrowest. */
const MIN_WIDTH = 240
/** What the frame takes of its own width: its padding on both sides and the sheet's border. */
const FRAME_SPACE = 24

const frame = ref<HTMLElement>()
const canvas = ref<HTMLCanvasElement>()
const status = ref<'loading' | 'ready' | 'failed'>('loading')
const current = ref(1)
const pageCount = ref(0)
const drawn = shallowRef<DrawnPage>()
// What the browser's own reading of each page came to.
const browserText = shallowRef<ReadonlyMap<number, PageText>>(new Map())
const agreement = shallowRef<ReadonlyMap<number, PageAgreement>>(new Map())
const checked = ref(false)

let engine: PdfDocument | undefined
// Which opening is current, and which drawing: a newer one makes the older stop touching the viewer.
let opening = 0
let drawing = 0
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let observer: ResizeObserver | undefined

const serverText = computed(() => new Map(props.pages.map(page => [page.page, page.text])))
const currentText = computed(() => serverText.value.get(current.value) ?? '')
const citations = computed(() => citationsOnPage(props.findings, current.value))
const differing = computed(() => [...agreement.value].filter(([, state]) => state === 'differs').map(([page]) => page).sort((a, b) => a - b))
const overall = computed<'checking' | 'match' | 'differs'>(() => {
  if (!checked.value) return 'checking'
  return differing.value.length === 0 ? 'match' : 'differs'
})
const pageAgrees = computed(() => agreement.value.get(current.value) === 'match')

// The boxes over the drawn page: only where the browser read exactly the server's text of this page.
const boxes = computed(() => {
  const page = drawn.value
  const text = browserText.value.get(current.value)
  if (!page || !text || !pageAgrees.value) return []
  return props.findings.flatMap((finding) => {
    if (finding.kind !== 'risk' || finding.citation.page !== current.value) return []
    return page.boxesFor(text, finding.citation.start, finding.citation.end).map((box, index) => ({ key: `${finding.id}-${index}`, id: finding.id, selected: finding.id === props.selectedId, ...box }))
  })
})

/** Draws the current page at the width the frame allows. */
async function draw(): Promise<void> {
  const target = canvas.value
  if (!engine || !target) return
  const mine = ++drawing
  // The frame's padding and the sheet's border are not room for the page.
  const room = (frame.value?.clientWidth ?? MAX_WIDTH) - FRAME_SPACE
  try {
    const page = await engine.draw(current.value, target, Math.max(Math.min(room, MAX_WIDTH), MIN_WIDTH))
    if (mine === drawing && page) drawn.value = page
  }
  catch {
    if (mine === drawing) status.value = 'failed'
  }
}

/** Reads every page's text with the browser's pdf.js, one after another, and says for each whether it is the server's text. */
async function compare(document: PdfDocument, mine: number): Promise<void> {
  for (let page = 1; page <= document.pageCount; page += 1) {
    try {
      const text = await document.textOf(page)
      if (mine !== opening) return
      browserText.value = new Map(browserText.value).set(page, text)
      agreement.value = new Map(agreement.value).set(page, agreementOf(serverText.value.get(page), text.text))
    }
    catch {
      if (mine !== opening) return
      agreement.value = new Map(agreement.value).set(page, 'differs')
    }
  }
  if (mine === opening) checked.value = true
}

/** Opens the PDF: loads pdf.js, draws the first page and starts the comparison of the texts. */
async function open(bytes: Uint8Array): Promise<void> {
  const mine = ++opening
  await close()
  status.value = 'loading'
  current.value = 1
  drawn.value = undefined
  browserText.value = new Map()
  agreement.value = new Map()
  checked.value = false
  try {
    const { openPdf } = await import('../pdf/engine')
    const document = await openPdf(bytes)
    if (mine !== opening) {
      await document.destroy()
      return
    }
    // A request to show a passage that came before the PDF was open is answered on the page it names.
    current.value = Math.min(findPageOfFocus() ?? 1, document.pageCount)
    pageCount.value = document.pageCount
    engine = document
    status.value = 'ready'
    await nextTick()
    await draw()
    void compare(document, mine)
  }
  catch {
    if (mine === opening) status.value = 'failed'
  }
}

/** Frees the open PDF, if there is one. */
async function close(): Promise<void> {
  const document = engine
  engine = undefined
  if (document) await document.destroy()
}

/** The page the latest request to show a finding is about, if it is about a passage. */
function findPageOfFocus(): number | undefined {
  const finding = props.findings.find(candidate => candidate.id === props.focus?.findingId)
  return finding?.kind === 'risk' ? finding.citation.page : undefined
}

/** Goes to a page, within the contract's pages. */
function go(page: number): void {
  if (!Number.isFinite(page)) return
  current.value = Math.min(Math.max(Math.trunc(page), 1), Math.max(pageCount.value, 1))
}

/** Reads the page number the visitor typed. */
function onNumber(event: Event): void {
  const input = event.target as HTMLInputElement
  go(Number(input.value))
  input.value = String(current.value)
}

/** Scrolls the viewer into view if it is below the fold, without animation for a visitor who prefers reduced motion. */
function bringIntoView(): void {
  const target = frame.value
  if (!target || typeof target.scrollIntoView !== 'function') return
  const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' })
}

watch(current, () => void draw())
watch(() => props.pdf, bytes => void open(bytes))
watch(() => props.focus, async (focus) => {
  const page = findPageOfFocus()
  if (focus === undefined || page === undefined) return
  go(page)
  await nextTick()
  bringIntoView()
})

onMounted(() => {
  void open(props.pdf)
  if (typeof ResizeObserver === 'undefined' || !frame.value) return
  observer = new ResizeObserver(() => {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => void draw(), 150)
  })
  observer.observe(frame.value)
})

onBeforeUnmount(() => {
  opening += 1
  observer?.disconnect()
  if (resizeTimer !== undefined) clearTimeout(resizeTimer)
  void close()
})
</script>

<template>
  <section
    class="lb4-section viewer"
    aria-labelledby="lb4-viewer-heading"
    data-testid="viewer"
    :data-status="status"
  >
    <h2 id="lb4-viewer-heading">
      {{ t('lb04.viewer.title') }}
    </h2>

    <div class="bar lb4-row">
      <button
        type="button"
        class="lb4-button"
        :disabled="status !== 'ready' || current <= 1"
        @click="go(current - 1)"
      >
        <LbIcon
          name="arrow-left"
          :size="16"
        />
        {{ t('lb04.viewer.previous') }}
      </button>
      <label class="number">
        {{ t('lb04.viewer.page') }}
        <input
          type="number"
          class="control lb4-nums"
          min="1"
          :max="Math.max(pageCount, 1)"
          :value="current"
          :disabled="status !== 'ready'"
          data-testid="viewer-page"
          @change="onNumber"
        >
        {{ t('lb04.viewer.of', { count: pageCount }) }}
      </label>
      <button
        type="button"
        class="lb4-button"
        :disabled="status !== 'ready' || current >= pageCount"
        @click="go(current + 1)"
      >
        {{ t('lb04.viewer.next') }}
        <LbIcon
          name="arrow-right"
          :size="16"
        />
      </button>
    </div>

    <p
      v-if="status === 'loading'"
      role="status"
      class="lb4-hint"
    >
      {{ t('lb04.viewer.loading') }}
    </p>
    <p
      v-else-if="status === 'failed'"
      role="alert"
      class="failed"
    >
      {{ t('lb04.viewer.failed') }}
    </p>

    <div
      ref="frame"
      class="frame"
      tabindex="0"
      role="group"
      :aria-label="t('lb04.viewer.area', { page: current, count: pageCount })"
      :hidden="status === 'failed'"
    >
      <div
        class="sheet"
        :style="drawn ? { width: `${drawn.width}px`, height: `${drawn.height}px` } : undefined"
      >
        <canvas
          ref="canvas"
          class="canvas"
          aria-hidden="true"
          data-testid="viewer-canvas"
        />
        <div
          class="overlay"
          aria-hidden="true"
        >
          <button
            v-for="box in boxes"
            :key="box.key"
            type="button"
            tabindex="-1"
            class="box"
            :class="{ 'box--on': box.selected }"
            :style="{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }"
            data-testid="highlight"
            :data-finding="box.id"
            @click="emit('select', box.id)"
          />
        </div>
      </div>
    </div>

    <p
      class="lb4-hint"
      role="status"
      data-testid="text-agreement"
      :data-state="overall"
    >
      <template v-if="overall === 'checking'">
        {{ t('lb04.viewer.checking') }}
      </template>
      <template v-else-if="overall === 'match'">
        {{ t('lb04.viewer.agrees', { count: pageCount }) }}
      </template>
      <template v-else>
        {{ t('lb04.viewer.differs', { pages: differing.join(', ') }) }}
      </template>
    </p>

    <details class="text">
      <summary>{{ t('lb04.viewer.asText', { page: current }) }}</summary>
      <PageTextView
        :text="currentText"
        :citations="citations"
      />
    </details>
  </section>
</template>

<style scoped>
.bar {
  align-items: center;
}

.number {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
}

.control {
  width: 4.5rem;
  padding: 5px 8px;
  font: 400 14px/1.4 var(--lb-font-sans);
  color: var(--lb-ink);
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.frame {
  max-width: 100%;
  padding: 10px;
  overflow: auto;
  background: var(--lb-shade);
  border: 1px solid var(--lb-rule);
}

.frame[hidden] {
  display: none;
}

/* The page is paper in both themes (--lb-paper is white in each), and the highlights are tinted for it. */
.sheet {
  position: relative;
  min-width: 1px;
  min-height: 1px;
  margin: 0 auto;
  border: 1px solid var(--lb-rule);
}

.canvas {
  display: block;
  background: var(--lb-paper);
}

.overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.box {
  position: absolute;
  padding: 0;
  pointer-events: auto;
  cursor: pointer;
  background: var(--lb-signal);
  border: 0;
  opacity: 0.26;
  mix-blend-mode: multiply;
}

.box--on {
  outline: 2px solid var(--lb-signal);
  outline-offset: 1px;
  opacity: 0.42;
}

.failed {
  font-weight: 700;
}

summary {
  font-size: 13.5px;
  cursor: pointer;
}

.text {
  display: grid;
  gap: 8px;
}
</style>
