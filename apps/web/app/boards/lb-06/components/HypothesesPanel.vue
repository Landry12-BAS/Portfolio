<script setup lang="ts">
// <HypothesesPanel>: the commander's ranking of what might be wrong, best first. Each hypothesis
// names a service and a cause, says how sure the commander is (in words and on a meter, never by
// colour), gives a sentence, and lists the evidence it rests on. The server has checked that every
// piece of evidence exists in the incident's log: a reference it could not find was thrown away
// before the ranking reached the board. The sentence is model output and is shown as plain text.
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useLb06Store } from '../store'
import { useLb06Words } from '../words'

defineProps<{
  /** The Brief reading leaves out the hypotheses' identifiers. */
  brief: boolean
}>()

const { t } = useI18n()
const words = useLb06Words()
const { hypotheses } = storeToRefs(useLb06Store())
</script>

<template>
  <section
    class="lb6-panel"
    :aria-label="t('lb06.hypotheses.title')"
    data-testid="hypotheses"
  >
    <h3>{{ t('lb06.hypotheses.title') }}</h3>
    <p
      v-if="!hypotheses"
      class="lb6-hint"
      data-testid="hypotheses-empty"
    >
      {{ t('lb06.hypotheses.empty') }}
    </p>
    <ol
      v-else
      class="list"
    >
      <li
        v-for="(item, index) in hypotheses"
        :key="item.id"
        class="item"
        :data-testid="`hypothesis-${index + 1}`"
      >
        <p class="head">
          <span class="lb6-chip">{{ t('lb06.hypotheses.rank', { rank: index + 1 }) }}</span>
          <strong>{{ t('lb06.hypotheses.where', { service: words.serviceName(item.service), cause: words.causeWord(item.cause) }) }}</strong>
        </p>
        <p class="sure">
          <meter
            min="0"
            max="1"
            :value="item.confidence"
            :aria-label="t('lb06.hypotheses.confidence', { value: t('lb06.hypotheses.confidenceValue', { value: Math.round(item.confidence * 100) }) })"
          />
          <span>{{ t('lb06.hypotheses.confidence', { value: t('lb06.hypotheses.confidenceValue', { value: Math.round(item.confidence * 100) }) }) }}</span>
        </p>
        <p class="summary">
          {{ item.summary }}
        </p>
        <p
          v-if="item.evidence.length > 0"
          class="refs"
        >
          <span class="lb6-hint">{{ t('lb06.hypotheses.evidence') }}:</span>
          <code
            v-for="ref in item.evidence"
            :key="ref"
            class="lb6-chip"
          >{{ ref }}</code>
        </p>
        <p
          v-if="!brief"
          class="lb6-hint lb6-mono"
        >
          {{ item.id }}
        </p>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.list {
  display: grid;
  gap: 12px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.item {
  display: grid;
  gap: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--lb-rule);
}
.head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: center;
  font-size: 14px;
}
.sure {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 13px;
}
.sure meter {
  width: 120px;
}
.summary {
  font-size: 14px;
  overflow-wrap: anywhere;
}
.refs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
code.lb6-chip {
  text-transform: none;
  letter-spacing: 0;
}
</style>
