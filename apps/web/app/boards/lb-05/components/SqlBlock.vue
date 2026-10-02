<script setup lang="ts">
// <SqlBlock>: a query shown as text, split into tokens so a keyword, a string, a number and a comment
// can each be drawn in their own style, with a button that copies it. Every token is a plain text
// node in a span: the query is a model's, or the checked query's, and is never parsed as markup and
// never run. The block scrolls sideways for a long line and can be reached with the keyboard.
import { LbIcon } from '@lb/icons'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { tokenizeSql } from '../sql'

const props = defineProps<{
  /** The query, exactly as it is to be shown and copied. */
  sql: string
  /** Names the block for assistive tech, such as "The query that ran". */
  label: string
  /** Hides the copy button, for text a visitor has no need to copy. */
  noCopy?: boolean
}>()

const { t } = useI18n()
const tokens = computed(() => tokenizeSql(props.sql))

// Copying needs the clipboard, which only a browser has, and only on a secure page.
const canCopy = ref(false)
const copied = ref(false)
onMounted(() => {
  canCopy.value = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
})

/** Copies the query to the clipboard and says so. */
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.sql)
    copied.value = true
  }
  catch {
    copied.value = false
  }
}
</script>

<template>
  <div
    class="sql"
    data-testid="sql-block"
  >
    <div
      class="scroll"
      role="region"
      tabindex="0"
      :aria-label="label"
    >
      <pre><code data-testid="sql-text"><span
        v-for="(token, index) in tokens"
        :key="index"
        :class="`tok tok--${token.kind}`"
      >{{ token.text }}</span></code></pre>
    </div>
    <div
      v-if="canCopy && !noCopy"
      class="bar"
    >
      <button
        type="button"
        class="copy"
        data-testid="sql-copy"
        @click="copy"
      >
        <LbIcon
          name="copy"
          :size="16"
          tone="mono"
        />
        {{ t('lb05.sql.copy') }}
      </button>
      <span
        class="copied"
        role="status"
      >{{ copied ? t('lb05.sql.copied') : '' }}</span>
    </div>
  </div>
</template>

<style scoped>
.sql {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.scroll {
  overflow-x: auto;
  background: var(--lb-shade);
  border: 1px solid var(--lb-rule);
}

pre {
  margin: 0;
  padding: 10px 12px;
  font-family: var(--lb-font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

code {
  font-family: inherit;
  font-size: inherit;
}

.tok--keyword {
  font-weight: 700;
  color: var(--lb-signal);
}

.tok--function {
  font-weight: 700;
}

.tok--string {
  color: var(--lb-ch3);
}

.tok--comment {
  font-style: italic;
  color: var(--lb-graphite);
}

.bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
}

.copy {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 5px 10px;
  font: 600 12.5px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.copy:hover {
  background: var(--lb-shade);
}

.copied {
  font-size: 12.5px;
  color: var(--lb-graphite);
}
</style>
