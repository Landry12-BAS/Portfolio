<script setup lang="ts">
// <ChatLog>: the conversation as a screen reader and a sighted visitor both read it: a log, whose new
// lines are announced politely as they arrive. Each line says who said it before what was said. A
// message the booking code wrote itself (a hold, a confirmation, a refusal) is marked as such, since
// it states facts from the database and not the model's words, and in the Technical reading the tools
// the model called in that turn are listed, including any the booking rules refused. Everything is
// text: the model's words and a tool name it made up are never read as markup. The log keeps to the
// bottom as lines arrive unless the visitor has scrolled up to read, and takes the keyboard's focus so
// it can be scrolled without a mouse.
import { LbIcon } from '@lb/icons'
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { typeset } from '~/board-kit/format'

import { toolOutcome } from '../chat'
import type { ChatLine } from '../chat'

const props = defineProps<{
  lines: readonly ChatLine[]
  /** Whether the concierge is working on a message. */
  working: boolean
  /** The language the conversation is in, which sets the voice a screen reader reads the lines in. */
  language: string
  /** The Brief reading leaves out the tools and the explanation of a receipt. */
  brief: boolean
  /** What the log says while it is empty. */
  empty: string
}>()

const { t } = useI18n()

const log = ref<HTMLElement>()
// Whether the visitor is reading the end of the log; if they scrolled up, new lines do not drag them down.
let atEnd = true

/** The language code for the lines, when it is a two-letter code a browser can use. */
function langOf(code: string): string | undefined {
  return /^[a-z]{2}$/.test(code) ? code : undefined
}

/** Remembers whether the visitor is at the end of the log. */
function onScroll(): void {
  const element = log.value
  if (!element) return
  atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 24
}

/** Scrolls to the newest line when the visitor was at the end, without animation for a visitor who asked for less motion. */
async function followEnd(): Promise<void> {
  await nextTick()
  const element = log.value
  if (!element || !atEnd) return
  element.scrollTop = element.scrollHeight
}

watch(() => [props.lines.length, props.working], followEnd, { flush: 'post' })

/** Puts the keyboard's focus on the log, which can be scrolled with the arrow keys once it has it. */
function focus(): void {
  log.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div
    ref="log"
    class="log"
    role="log"
    tabindex="0"
    aria-relevant="additions"
    :aria-label="t('lb02.chat.logLabel')"
    data-testid="chat-log"
    @scroll.passive="onScroll"
  >
    <p
      v-if="lines.length === 0"
      class="empty"
    >
      {{ empty }}
    </p>
    <ol
      v-else
      class="lines"
    >
      <li
        v-for="line in lines"
        :key="line.id"
        class="line"
        :class="`line--${line.kind}`"
        :data-testid="`line-${line.kind}`"
      >
        <template v-if="line.kind === 'action'">
          <span class="note-label">{{ t('lb02.chat.note') }}</span>
          <span class="note">{{ line.text }}</span>
        </template>
        <span
          v-else-if="line.kind === 'pause'"
          class="note"
        >{{ t('lb02.chat.later', { minutes: line.minutes }) }}</span>
        <template v-else>
          <span class="who">{{ line.kind === 'visitor' ? t('lb02.chat.you') : t('lb02.chat.concierge') }}</span>
          <p
            class="bubble"
            :class="{ 'bubble--receipt': line.kind === 'concierge' && line.receipt !== null }"
            :lang="langOf(language)"
          >
            {{ line.kind === 'concierge' ? typeset(line.text, language) : line.text }}
          </p>
          <template v-if="line.kind === 'concierge'">
            <p
              v-if="line.receipt !== null"
              class="receipt"
              data-testid="receipt"
              :data-receipt="line.receipt"
            >
              <LbIcon
                name="shield"
                :size="14"
                tone="mono"
              />
              <span>{{ t('lb02.chat.receipt') }}: {{ t(`lb02.chat.receipts.${line.receipt}`) }}</span>
            </p>
            <p
              v-if="line.receipt !== null && !brief"
              class="help"
            >
              {{ t('lb02.chat.receiptHelp') }}
            </p>
            <ul
              v-if="line.tools.length > 0 && !brief"
              class="tools"
              :aria-label="t('lb02.chat.tools')"
              data-testid="tools"
            >
              <li
                v-for="(tool, index) in line.tools"
                :key="index"
                :data-outcome="toolOutcome(tool)"
              >
                <code>{{ tool.name }}</code>
                <span>{{ t(`lb02.chat.toolOutcome.${toolOutcome(tool)}`) }}</span>
              </li>
            </ul>
          </template>
        </template>
      </li>
    </ol>
    <p
      v-if="working"
      class="working"
      role="status"
      data-testid="working"
    >
      <span
        class="dots"
        aria-hidden="true"
      ><i /><i /><i /></span>
      {{ t('lb02.chat.working') }}
    </p>
  </div>
</template>

<style scoped>
.log {
  min-height: 0;
  padding: 14px 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.empty {
  padding: 12px;
  font-size: 14px;
  color: var(--lb-graphite);
}

.lines {
  display: grid;
  gap: 12px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.line {
  display: grid;
  gap: 3px;
  max-width: 92%;
}

.line--visitor {
  justify-self: end;
  justify-items: end;
}

.line--concierge {
  justify-self: start;
}

.line--action,
.line--pause {
  justify-self: center;
  justify-items: center;
  max-width: 100%;
  text-align: center;
}

.who {
  font-family: var(--lb-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.bubble {
  padding: 8px 12px;
  font-size: 14px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  border-radius: 16px;
}

.line--visitor .bubble {
  color: var(--lb-sheet);
  background: var(--lb-ink);
  border-bottom-right-radius: 4px;
}

.line--concierge .bubble {
  color: var(--lb-ink);
  background: var(--lb-shade);
  border: 1px solid var(--lb-rule);
  border-bottom-left-radius: 4px;
}

.line--concierge .bubble.bubble--receipt {
  border: 1.5px dashed var(--lb-signal);
}

.receipt {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.03em;
  color: var(--lb-ink);
}

.help {
  font-size: 12px;
  color: var(--lb-graphite);
}

.tools {
  display: grid;
  gap: 2px;
  padding: 0;
  margin: 2px 0 0;
  font-size: 12px;
  list-style: none;
}

.tools li {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  align-items: baseline;
}

.tools code {
  padding: 0 4px;
  background: var(--lb-shade);
  border: 1px solid var(--lb-rule);
  overflow-wrap: anywhere;
}

.tools li[data-outcome="refused"] span,
.tools li[data-outcome="failed"] span {
  font-weight: 700;
}

.note-label {
  font-family: var(--lb-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.note {
  font-size: 12px;
  color: var(--lb-graphite);
  overflow-wrap: anywhere;
}

.working {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.dots {
  display: inline-flex;
  gap: 4px;
}

.dots i {
  width: 6px;
  height: 6px;
  background: currentcolor;
  border-radius: 50%;
  animation: blink 1.2s ease-in-out infinite;
}

.dots i:nth-child(2) {
  animation-delay: 0.2s;
}

.dots i:nth-child(3) {
  animation-delay: 0.4s;
}

@media (prefers-reduced-motion: reduce) {
  .dots i {
    opacity: 0.7;
    animation: none;
  }
}

@keyframes blink {
  0%,
  100% {
    opacity: 0.25;
  }

  50% {
    opacity: 1;
  }
}
</style>
