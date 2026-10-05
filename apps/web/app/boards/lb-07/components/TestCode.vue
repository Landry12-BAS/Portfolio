<script setup lang="ts">
// <TestCode>: the Playwright test the service generated, in a code view: its file name and verdict, a line
// that says a template wrote it from the checked plan and that the service never runs it, the code itself
// with line numbers (text spans only, cut into comments, strings and keywords by a plain scan, never
// markup), a copy button that says when it copied, and a download. The view scrolls on its own, so a long
// line never widens the page, and it can be scrolled from the keyboard.
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { tokenize } from '../code'
import { useLb07Store } from '../store'
import { useLb07Words } from '../words'

const { t } = useI18n()
const words = useLb07Words()
const { test, testStatus } = storeToRefs(useLb07Store())
const id = useId()

// How long "Copied" stays before the button reads as it did.
const COPIED_FOR_MS = 4_000

const lines = computed(() => (test.value ? tokenize(test.value.source) : []))
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
const downloadUrl = ref<string>()
let copyTimer: ReturnType<typeof setTimeout> | undefined

/** Copies the test's text, and says whether the browser let it. */
async function copy(): Promise<void> {
  if (!test.value) return
  if (copyTimer !== undefined) clearTimeout(copyTimer)
  try {
    await navigator.clipboard.writeText(test.value.source)
    copyState.value = 'copied'
  }
  catch {
    copyState.value = 'failed'
  }
  copyTimer = setTimeout(() => {
    copyState.value = 'idle'
  }, COPIED_FOR_MS)
}

/** Makes the address the download link points at: the test's text as a file in the browser's own memory. */
function prepareDownload(): void {
  if (downloadUrl.value !== undefined) URL.revokeObjectURL(downloadUrl.value)
  downloadUrl.value = undefined
  if (!test.value || typeof URL.createObjectURL !== 'function') return
  downloadUrl.value = URL.createObjectURL(new Blob([test.value.source], { type: 'text/plain;charset=utf-8' }))
}

watch(test, prepareDownload, { immediate: typeof window !== 'undefined' })

onBeforeUnmount(() => {
  if (copyTimer !== undefined) clearTimeout(copyTimer)
  if (downloadUrl.value !== undefined) URL.revokeObjectURL(downloadUrl.value)
})
</script>

<template>
  <section
    v-if="testStatus !== 'idle'"
    class="lb7-panel"
    :aria-labelledby="`${id}-title`"
    data-testid="test"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb07.test.title') }}
    </h2>
    <p
      v-if="testStatus === 'loading'"
      class="lb7-hint"
    >
      {{ t('lb07.test.loading') }}
    </p>
    <p
      v-else-if="testStatus === 'failed'"
      class="lb7-hint"
      data-testid="test-failed"
    >
      {{ t('lb07.test.failed') }}
    </p>
    <template v-if="test">
      <p class="file">
        <span class="lb7-label">{{ t('lb07.test.file') }}</span>
        <span
          class="lb7-mono"
          data-testid="test-filename"
        >{{ test.filename }}</span>
        <span class="lb7-chip">{{ words.verdictWord(test.verdict) }}</span>
      </p>
      <p
        class="template"
        data-testid="never-runs"
      >
        {{ t('lb07.test.template') }}
      </p>
      <div class="lb7-row">
        <button
          type="button"
          class="lb7-button"
          :aria-describedby="`${id}-copied`"
          data-testid="copy-test"
          @click="copy"
        >
          {{ copyState === 'copied' ? t('lb07.test.copied') : t('lb07.test.copy') }}
        </button>
        <a
          v-if="downloadUrl"
          class="lb7-button"
          :href="downloadUrl"
          :download="test.filename"
          data-testid="download-test"
        >{{ t('lb07.test.download') }}</a>
      </div>
      <!-- "Copied" is said on the button already, so the line says it to a screen reader only; a failure is shown to everyone. -->
      <p
        :id="`${id}-copied`"
        :class="copyState === 'failed' ? 'lb7-hint' : 'lb-sr-only'"
        role="status"
        data-testid="copy-status"
      >
        {{ copyState === 'copied' ? t('lb07.test.copied') : copyState === 'failed' ? t('lb07.test.copyFailed') : '' }}
      </p>
      <div
        class="code"
        role="region"
        tabindex="0"
        :aria-label="t('lb07.test.codeLabel', { count: lines.length })"
        lang="en"
        data-testid="test-code"
      >
        <div
          v-for="(line, index) in lines"
          :key="index"
          class="line"
        >
          <span
            class="number"
            aria-hidden="true"
          >{{ index + 1 }}</span>
          <code class="text"><span
            v-for="(token, place) in line"
            :key="place"
            :class="`token token--${token.kind}`"
          >{{ token.text }}</span></code>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.file {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}
.template {
  padding: 8px 10px;
  font-size: 13px;
  background: var(--lb-shade);
  border-left: 3px solid var(--lb-ink);
}
.code {
  max-height: 520px;
  padding: 8px 0;
  overflow: auto;
  font-family: var(--lb-font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--lb-ink);
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}
.code:focus-visible {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}
.line {
  display: grid;
  grid-template-columns: 3.5em max-content;
  min-width: max-content;
}
.number {
  padding-right: 10px;
  text-align: right;
  color: var(--lb-graphite);
  user-select: none;
}
.text {
  padding-right: 12px;
  font: inherit;
  white-space: pre;
}
.token--comment {
  font-style: italic;
  color: var(--lb-graphite);
}
.token--keyword {
  font-weight: 700;
}
.token--string {
  color: var(--lb-ink);
  text-decoration: underline dotted var(--lb-rule);
  text-underline-offset: 3px;
}
</style>
