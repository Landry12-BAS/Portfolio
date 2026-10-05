<script setup lang="ts">
// <TimelinePanel>: what happened in the incident, in order, as sentences worded from the log's own
// events: the fault, the alert, the agents starting, the ranking, each proposal and decision, the fix,
// the recovery. The ticks (which the charts draw) and the agents' steps (which have their own panel)
// are left out. Every sentence is built here from the event's kind and numbers, so it is in the
// visitor's language whatever the service sent.
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useLb06Store } from '../store'
import { useLb06Words } from '../words'

defineProps<{
  /** The Brief reading leaves out the events' numbers. */
  brief: boolean
}>()

const { t } = useI18n()
const words = useLb06Words()
const { timeline } = storeToRefs(useLb06Store())
</script>

<template>
  <section
    class="lb6-panel"
    :aria-label="t('lb06.timeline.title')"
    data-testid="timeline"
  >
    <h3>{{ t('lb06.timeline.title') }}</h3>
    <p
      v-if="timeline.length === 0"
      class="lb6-hint"
    >
      {{ t('lb06.timeline.empty') }}
    </p>
    <ol
      v-else
      class="list"
    >
      <li
        v-for="event in timeline"
        :key="event.seq"
        :data-testid="`timeline-${event.kind}`"
      >
        <span class="when lb6-mono">{{ t('lb06.timeline.minute', { minute: event.minute }) }}</span>
        <span>{{ words.eventText(event) }}</span>
        <span
          v-if="!brief"
          class="lb6-hint lb6-mono"
        >{{ t('lb06.timeline.technical', { seq: event.seq }) }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.list {
  display: grid;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
  font-size: 13.5px;
}
.list li {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  align-items: baseline;
}
.when {
  min-width: 78px;
  font-size: 12px;
  color: var(--lb-graphite);
}
</style>
