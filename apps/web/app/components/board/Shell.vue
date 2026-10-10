<script setup lang="ts">
// <BoardShell>: the frame every evaluation board sits in. A deep-blue title bar carries the part
// number, the system's name and a badge that says plainly whether what is shown is a live run
// or the replay of a recording; below it, a main column for the demo, a side column for the
// limits and the visitor's counters, and the Scope across the full width underneath. The deep
// blue marks a live demo and is used for nothing else.
import { LbIcon } from '@lb/icons'
import { useI18n } from 'vue-i18n'

defineProps<{
  /** The part number, such as `LB-01`. */
  part: string
  /** The system's name, such as `Support Copilot`. */
  name: string
  /** Whether the board is showing a live run or a replay. */
  state: 'live' | 'replay'
}>()

const { t } = useI18n()
</script>

<template>
  <section
    class="board"
    :aria-label="`${part} ${name}, ${t('board.title')}`"
  >
    <header class="bar">
      <p class="part">
        {{ part }}
      </p>
      <p class="name">
        {{ name }}
        <span class="kind">{{ t('board.title') }}</span>
      </p>
      <p
        class="badge"
        :class="`badge--${state}`"
        data-testid="board-state"
      >
        <LbIcon
          :name="state === 'live' ? 'live' : 'replay'"
          :size="16"
          tone="mono"
        />
        <span>{{ state === 'live' ? t('board.live') : t('board.replay') }}</span>
      </p>
    </header>
    <div class="frame">
      <div class="main">
        <slot />
      </div>
      <aside
        class="side"
        :aria-label="t('board.side')"
      >
        <slot name="aside" />
      </aside>
    </div>
    <div
      v-if="$slots.wide"
      class="wide"
    >
      <slot name="wide" />
    </div>
    <div
      v-if="$slots.scope"
      class="trace"
    >
      <slot name="scope" />
    </div>
  </section>
</template>

<style scoped>
.board {
  border: 2px solid var(--lb-board);
  background: var(--lb-sheet);
}

.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  padding: 10px 16px;
  color: var(--lb-silk);
  background: var(--lb-board-deep);
}

.part {
  font-family: var(--lb-font-mono);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.name {
  flex: 1 1 auto;
  font-size: 15px;
  font-weight: 700;
}

.kind {
  margin-left: 10px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.85;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  border: 1.5px solid var(--lb-silk);
  border-radius: 999px;
}

/* A replay is drawn dashed, as a later or provisional state is elsewhere in the catalog. */
.badge--replay {
  border-style: dashed;
}

.frame {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(280px, 1fr);
  gap: 0;
}

.main,
.side {
  display: grid;
  gap: 20px;
  align-content: start;
  min-width: 0;
  padding: 18px 16px;
}

.side {
  border-left: 1px solid var(--lb-rule);
  background: var(--lb-board-tint);
}

/* A board whose work needs more room than the main column (a canvas next to its form) puts it here, under both columns. */
.wide {
  display: grid;
  gap: 20px;
  align-content: start;
  min-width: 0;
  padding: 18px 16px;
  border-top: 1px solid var(--lb-rule);
}

/* The Scope's trace is a wide table, so it gets the whole width of the board under both columns. */
.trace {
  padding: 18px 16px;
  border-top: 1px solid var(--lb-rule);
}

@media (max-width: 900px) {
  .frame {
    grid-template-columns: minmax(0, 1fr);
  }

  .side {
    border-top: 1px solid var(--lb-rule);
    border-left: 0;
  }
}
</style>
