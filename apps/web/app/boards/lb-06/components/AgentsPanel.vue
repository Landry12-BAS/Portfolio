<script setup lang="ts">
// <AgentsPanel>: what the agents did, step by step, drawn from their structured outputs and never
// from raw model text. The commander plans and asks each specialist a question; each specialist reads
// the shop through a read-only tool and reports findings, every one with the evidence it rests on; the
// commander then ranks the hypotheses (the next panel). A step that cost a model call says so, and
// the counter shows the calls used of the cap the server enforces. Evidence the log does not hold is
// thrown away by the server, and the panel says how much. The agents' sentences are model output and
// are shown as plain text, nothing else.
import { LB06_LIMITS } from '@lb/contracts'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useLb06Store } from '../store'
import { useLb06Words } from '../words'

defineProps<{
  /** The Brief reading leaves out the numbers of the events and the tools' arguments. */
  brief: boolean
}>()

const { t } = useI18n()
const words = useLb06Words()
const { steps, modelCalls, discarded } = storeToRefs(useLb06Store())

/** Writes a tool call's arguments as `name: value` pairs. */
function argsText(args: Record<string, string | number | boolean>): string {
  return Object.entries(args).map(([name, value]) => `${name}: ${String(value)}`).join(', ')
}
</script>

<template>
  <section
    class="lb6-panel"
    :aria-label="t('lb06.agents.title')"
    data-testid="agents"
  >
    <h3>{{ t('lb06.agents.title') }}</h3>
    <p
      v-if="!brief"
      class="lb6-hint"
    >
      {{ t('lb06.agents.intro') }}
    </p>
    <p
      class="cap"
      data-testid="agents-cap"
    >
      <meter
        min="0"
        :max="LB06_LIMITS.stepCap"
        :value="modelCalls"
        :aria-label="t('lb06.agents.cap', { used: modelCalls, cap: LB06_LIMITS.stepCap })"
      />
      <span>{{ t('lb06.agents.cap', { used: modelCalls, cap: LB06_LIMITS.stepCap }) }}</span>
    </p>
    <p
      v-if="steps.length === 0"
      class="lb6-hint"
      data-testid="agents-empty"
    >
      {{ t('lb06.agents.empty') }}
    </p>
    <ol
      v-else
      class="steps"
    >
      <li
        v-for="row in steps"
        :key="row.seq"
        class="step"
        data-testid="agent-step"
        :data-spent="row.spent"
        :data-agent="row.agent"
      >
        <p class="line">
          <span class="lb6-chip">{{ words.agentName(row.agent) }}</span>
          <span>{{ t(`lb06.agents.kinds.${row.kind}`) }}</span>
          <span class="lb6-hint">{{ row.modelCall ? t('lb06.agents.modelCall') : t('lb06.agents.noModelCall') }}</span>
        </p>
        <ul
          v-if="row.plan"
          class="detail"
        >
          <li
            v-for="(item, index) in row.plan.questions"
            :key="index"
          >
            {{ t('lb06.agents.question', { agent: words.agentName(item.agent), question: item.question }) }}
          </li>
        </ul>
        <p
          v-if="row.toolCall"
          class="detail lb6-mono"
        >
          {{ t('lb06.agents.tool', { tool: row.toolCall.tool, args: brief ? '…' : argsText(row.toolCall.args), rows: row.toolCall.rows }) }}
        </p>
        <template v-if="row.report">
          <p
            v-if="row.report.findings.length === 0"
            class="detail lb6-hint"
          >
            {{ t('lb06.agents.noFindings') }}
          </p>
          <ul
            v-else
            class="detail"
          >
            <li
              v-for="(finding, index) in row.report.findings"
              :key="index"
            >
              <span>{{ finding.text }}</span>
              <span
                v-if="finding.evidence.length > 0"
                class="refs"
              >
                <span class="lb6-hint">{{ t('lb06.agents.evidence') }}:</span>
                <code
                  v-for="ref in finding.evidence"
                  :key="ref"
                  class="lb6-chip"
                >{{ ref }}</code>
              </span>
            </li>
          </ul>
        </template>
        <p
          v-if="!brief"
          class="lb6-hint"
        >
          {{ t('lb06.agents.technicalStep', { seq: row.seq, minute: row.minute, step: row.spent }) }}
        </p>
      </li>
    </ol>
    <p
      v-if="discarded > 0"
      class="lb6-hint"
      role="status"
      data-testid="evidence-discarded"
    >
      {{ t('lb06.agents.discarded', { count: discarded }) }}
    </p>
  </section>
</template>

<style scoped>
.cap {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 13.5px;
  font-weight: 600;
}
.cap meter {
  width: 140px;
}
.steps {
  display: grid;
  gap: 10px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.step {
  display: grid;
  gap: 4px;
  padding: 8px 0;
  border-top: 1px solid var(--lb-rule);
}
.line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: center;
  font-size: 13.5px;
}
.detail {
  display: grid;
  gap: 4px;
  padding: 0 0 0 18px;
  margin: 0;
  font-size: 13.5px;
  overflow-wrap: anywhere;
}
.refs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  margin-top: 2px;
}
code.lb6-chip {
  text-transform: none;
  letter-spacing: 0;
}
</style>
