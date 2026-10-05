<script setup lang="ts">
// <PostmortemPanel>: what the incident leaves behind. It has two parts and says which is which: a
// timeline built by code from the log (the part to trust), and prose a model wrote over it, which the
// server checked references only events the log holds. If no prose could be trusted the panel says
// so and shows the timeline alone. An incident that ends early has no postmortem. The timeline's rows
// are worded here from the log's events, so they are in the visitor's language; a row whose event the
// board does not hold shows the service's own English line, marked as such.
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLb06Store } from '../store'
import { useLb06Words } from '../words'

defineProps<{
  /** The Brief reading leaves out the events the prose rests on. */
  brief: boolean
}>()

const { t } = useI18n()
const words = useLb06Words()
const { postmortem, state, events } = storeToRefs(useLb06Store())

const visible = computed(() => state.value === 'writing_postmortem' || state.value === 'closed' || state.value === 'aborted' || state.value === 'failed')
const bySeq = computed(() => new Map(events.value.map(event => [event.seq, event])))
const rows = computed(() => (postmortem.value?.timeline ?? []).map((row) => {
  const event = bySeq.value.get(row.seq)
  return { seq: row.seq, minute: row.minute, text: event ? words.eventText(event) : row.detail, own: event !== undefined }
}))
const sections = computed(() => {
  const prose = postmortem.value?.prose
  if (!prose) return []
  return [
    { key: 'summary', title: t('lb06.postmortem.summary'), text: prose.summary },
    { key: 'rootCause', title: t('lb06.postmortem.rootCause'), text: prose.rootCause },
    { key: 'wentWell', title: t('lb06.postmortem.wentWell'), text: prose.whatWentWell },
  ]
})
</script>

<template>
  <section
    v-if="visible"
    class="lb6-panel"
    :aria-label="t('lb06.postmortem.title')"
    data-testid="postmortem"
  >
    <h3>{{ t('lb06.postmortem.title') }}</h3>
    <p
      v-if="state === 'aborted' || state === 'failed'"
      class="lb6-hint"
      data-testid="postmortem-none"
    >
      {{ t('lb06.postmortem.none') }}
    </p>
    <p
      v-else-if="!postmortem"
      class="lb6-hint"
      data-testid="postmortem-waiting"
    >
      {{ t('lb06.postmortem.waiting') }}
    </p>
    <template v-else>
      <p
        class="lb6-hint"
        data-testid="postmortem-cost"
      >
        {{ t('lb06.postmortem.cost', { calls: postmortem.modelCalls, proposals: postmortem.proposals, minute: postmortem.recoveredMinute ?? 0 }) }}
      </p>
      <div>
        <h4>{{ t('lb06.postmortem.timeline') }}</h4>
        <ol
          class="rows"
          data-testid="postmortem-timeline"
        >
          <li
            v-for="row in rows"
            :key="row.seq"
          >
            <span class="when lb6-mono">{{ t('lb06.timeline.minute', { minute: row.minute }) }}</span>
            <span :lang="row.own ? undefined : 'en'">{{ row.text }}</span>
          </li>
        </ol>
      </div>
      <div data-testid="postmortem-prose">
        <h4>{{ t('lb06.postmortem.prose') }}</h4>
        <p
          v-if="sections.length === 0"
          class="lb6-hint"
          data-testid="postmortem-no-prose"
        >
          {{ t('lb06.postmortem.noProse') }}
        </p>
        <template v-else>
          <section
            v-for="section in sections"
            :key="section.key"
            class="part"
          >
            <h5>{{ section.title }}</h5>
            <p>{{ section.text }}</p>
          </section>
          <section
            v-if="postmortem.prose"
            class="part"
          >
            <h5>{{ t('lb06.postmortem.actionItems') }}</h5>
            <ul>
              <li
                v-for="(item, index) in postmortem.prose.actionItems"
                :key="index"
              >
                {{ item }}
              </li>
            </ul>
          </section>
          <p
            v-if="postmortem.prose && !brief"
            class="refs"
          >
            <span class="lb6-hint">{{ t('lb06.postmortem.references') }}:</span>
            <code
              v-for="ref in postmortem.prose.references"
              :key="ref"
              class="lb6-chip"
            >{{ ref }}</code>
          </p>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
h4 {
  margin: 0 0 4px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}
h5 {
  margin: 8px 0 2px;
  font-size: 13.5px;
}
.rows {
  display: grid;
  gap: 4px;
  padding: 0;
  margin: 0;
  font-size: 13.5px;
  list-style: none;
}
.rows li {
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
.part p,
.part li {
  font-size: 14px;
  overflow-wrap: anywhere;
}
.part ul {
  padding-left: 18px;
  margin: 0;
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
