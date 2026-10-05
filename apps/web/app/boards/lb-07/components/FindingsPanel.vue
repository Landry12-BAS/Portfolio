<script setup lang="ts">
// <FindingsPanel>: the findings of a finished run, which code made and no model: what kind each is, which
// engine saw it, at which step and on which page, and what code saw, quoted as text (the page's own words,
// an address, an axe rule), never as markup. A step past the main pass's last is one of the later passes
// (the second engine, the clean shop), and the board says so instead of naming a step the visitor cannot see.
import type { Lb07Finding, Lb07FindingKind } from '@lb/contracts'
import { LbIcon } from '@lb/icons'
import type { IconName } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLb07Store } from '../store'
import { useLb07Words } from '../words'

defineProps<{
  /** The Brief reading leaves out the axe rule's id. */
  brief: boolean
}>()

const { t } = useI18n()
const words = useLb07Words()
const { run, report } = storeToRefs(useLb07Store())
const id = useId()

const ICONS: Readonly<Record<Lb07FindingKind, IconName>> = { expectation_failed: 'warning', console_error: 'code', failed_request: 'error', accessibility: 'info', blocked_navigation: 'shield' }

const findings = computed(() => report.value?.findings ?? [])

/** Says when a finding was made: at a step of the main pass, in a later pass, or between steps. */
function whenOf(finding: Lb07Finding): string {
  if (finding.stepIndex === null) return t('lb07.findings.betweenSteps')
  const steps = run.value?.steps.length ?? 0
  return finding.stepIndex < steps ? t('lb07.findings.atStep', { number: finding.stepIndex + 1 }) : t('lb07.findings.otherPass')
}
</script>

<template>
  <section
    v-if="report"
    class="lb7-panel"
    :aria-labelledby="`${id}-title`"
    data-testid="findings"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb07.findings.title') }}
    </h2>
    <p
      v-if="!brief"
      class="lb7-hint"
    >
      {{ t('lb07.findings.intro') }}
    </p>
    <p
      v-if="findings.length === 0"
      data-testid="no-findings"
    >
      {{ t('lb07.findings.none') }}
    </p>
    <ul
      v-else
      class="list"
    >
      <li
        v-for="finding in findings"
        :id="`lb07-finding-${finding.id}`"
        :key="finding.id"
        class="finding"
        :data-kind="finding.kind"
        data-testid="finding"
      >
        <p class="kind">
          <LbIcon
            :name="ICONS[finding.kind]"
            :size="16"
            tone="mono"
          />
          <span>{{ words.kindWord(finding.kind) }}</span>
          <span class="lb7-chip">{{ t('lb07.findings.number', { number: finding.id.slice(1) }) }}</span>
        </p>
        <dl class="lb7-facts">
          <div>
            <dt>{{ t('lb07.findings.when') }}</dt>
            <dd>{{ whenOf(finding) }}</dd>
          </div>
          <div>
            <dt>{{ t('lb07.findings.engine') }}</dt>
            <dd>{{ words.engineName(finding.engine) }}</dd>
          </div>
          <div v-if="finding.path !== null">
            <dt>{{ t('lb07.findings.page') }}</dt>
            <dd class="lb7-mono">
              {{ finding.path }}
            </dd>
          </div>
          <div v-if="!brief && finding.rule !== null">
            <dt>{{ t('lb07.findings.rule') }}</dt>
            <dd class="lb7-mono">
              {{ finding.rule }}
            </dd>
          </div>
        </dl>
        <p class="lb7-label">
          {{ t('lb07.findings.saw') }}
        </p>
        <p
          class="lb7-quote lb7-mono"
          lang="en"
          data-testid="finding-detail"
        >
          {{ finding.detail }}
        </p>
      </li>
    </ul>
    <p
      v-if="report.findingsDropped > 0"
      class="lb7-hint"
    >
      {{ t('lb07.findings.dropped', { count: report.findingsDropped }) }}
    </p>
  </section>
</template>

<style scoped>
.list {
  display: grid;
  gap: 10px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.finding {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--lb-rule);
  border-left-width: 3px;
  border-left-color: var(--lb-ink);
}
.kind {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-weight: 700;
}
</style>
