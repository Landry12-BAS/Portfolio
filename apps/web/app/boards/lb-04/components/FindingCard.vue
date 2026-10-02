<script setup lang="ts">
// <FindingCard>: one finding of a report. It says how serious it is, which rule of the playbook it rests on and
// where in the contract it is, and then the passage itself as real text, the contract's own words at the
// place the citation names: the server checked them against the contract's text, and the board shows
// them whether or not the PDF viewer is open. A clause the playbook expects and the contract lacks has no
// passage; it says what the whole text was searched for. Two buttons act on the finding: one shows the
// passage in the PDF, and one asks for a proposed wording, which costs one model call and one of the
// contract's three redlines and so is offered only on a live review.
import { LbIcon } from '@lb/icons'
import type { Lb04Finding, Lb04Redline } from '@lb/contracts'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import RedlineView from './RedlineView.vue'
import SeverityMark from './SeverityMark.vue'

const props = defineProps<{
  finding: Lb04Finding
  /** Whether this is the finding the PDF viewer is showing. */
  selected: boolean
  /** The redline already made for it, if there is one. */
  redline: Lb04Redline | undefined
  /** Whether a redline may be asked for now: a live review, with redlines left, and none being made. */
  canRedline: boolean
  /** Whether this finding's redline is being made. */
  redlining: boolean
  /** Whether the board is live, which is the only time a redline can be asked for. */
  live: boolean
  brief: boolean
}>()

const emit = defineEmits<{ show: [id: string], redline: [id: string] }>()

const { t } = useI18n()

const topic = computed(() => t(`lb04.topics.${props.finding.topic}`))
const place = computed(() => {
  if (props.finding.kind !== 'risk') return t('lb04.finding.missing')
  const { clause, citation } = props.finding
  return clause === null ? t('lb04.finding.page', { page: citation.page }) : t('lb04.finding.clausePage', { clause, page: citation.page })
})
</script>

<template>
  <article
    :id="`lb4-finding-${finding.id}`"
    class="finding"
    :class="{ 'finding--selected': selected }"
    :aria-labelledby="`lb4-finding-${finding.id}-title`"
    :data-finding="finding.id"
    :data-kind="finding.kind"
  >
    <header class="head">
      <h4
        :id="`lb4-finding-${finding.id}-title`"
        class="title"
      >
        {{ finding.title }}
      </h4>
      <SeverityMark :severity="finding.severity" />
    </header>

    <p class="meta">
      <span class="lb4-chip">{{ topic }}</span>
      <span class="place lb4-nums">{{ place }}</span>
      <span
        v-if="!brief"
        class="source"
      >{{ finding.source === 'model' ? t('lb04.finding.byModel') : t('lb04.finding.byDetector') }}</span>
    </p>

    <p class="summary">
      {{ finding.summary }}
    </p>

    <blockquote
      v-if="finding.kind === 'risk'"
      class="passage"
      data-testid="passage"
    >
      <p class="lb-label">
        {{ t('lb04.finding.passage') }}
      </p>
      <p class="quote">
        <mark>{{ finding.quote }}</mark>
      </p>
    </blockquote>
    <p
      v-else
      class="searched"
    >
      {{ t('lb04.finding.searched') }}
      <span
        v-if="!brief"
        class="phrases"
      >{{ finding.searched.join(' · ') }}</span>
    </p>

    <div class="actions">
      <button
        v-if="finding.kind === 'risk'"
        type="button"
        class="lb4-button"
        :aria-pressed="selected"
        :aria-describedby="`lb4-finding-${finding.id}-title`"
        @click="emit('show', finding.id)"
      >
        <LbIcon
          name="search"
          :size="16"
        />
        {{ t('lb04.finding.show') }}
      </button>
      <button
        v-if="live && !redline"
        type="button"
        class="lb4-button lb4-button--quiet"
        :disabled="!canRedline"
        :aria-describedby="`lb4-finding-${finding.id}-title`"
        @click="emit('redline', finding.id)"
      >
        {{ redlining ? t('lb04.finding.redlining') : t('lb04.finding.redline') }}
      </button>
    </div>

    <RedlineView
      v-if="redline"
      :redline="redline"
      :brief="brief"
    />
  </article>
</template>

<style scoped>
.finding {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 12px 14px;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}

.finding--selected {
  border: 2px solid var(--lb-signal);
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}

.title {
  font-size: 15px;
  font-weight: 700;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  font-size: 12.5px;
  color: var(--lb-graphite);
}

.summary {
  max-width: 70ch;
  font-size: 14px;
}

.passage {
  display: grid;
  gap: 2px;
  padding: 8px 12px;
  margin: 0;
  background: var(--lb-shade);
  border-left: 3px solid var(--lb-ink);
}

.quote {
  max-width: 70ch;
  font-size: 14px;
  line-height: 1.6;
}

.searched {
  font-size: 13px;
  color: var(--lb-graphite);
}

.phrases {
  font-family: var(--lb-font-mono);
  font-size: 12px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.actions:empty {
  display: none;
}
</style>
