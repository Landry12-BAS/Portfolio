<script setup lang="ts">
// <MyMeetings>: the visitor's meetings of the last 24 hours, so a reload, another tab or a later visit does not
// lose them. The service keeps a meeting's transcript and items for 24 hours (the audio is deleted once it is
// transcribed), and the board lists each here with what it was (a curated meeting by its title, or the visitor's
// own recording), the mode it ran in, when it was sent and where it stands, with a button that opens it: a finished
// meeting is read whole, one still going is followed again. Whether it counted against the day is said too, since a
// meeting the service could not finish gives its place back.
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { givesPlaceBack, isLb09SampleId } from '../outcome'
import type { Meeting } from '../schemas'
import { useLb09Store } from '../store'

const { t, locale } = useI18n()
const store = useLb09Store()
const { mine, mineStatus, meeting, runMode, phase } = storeToRefs(store)

// A live meeting is being started or followed: another cannot be opened until it is done.
const busy = computed(() => runMode.value === 'live' && (phase.value === 'starting' || phase.value === 'working'))

/** Names a meeting: the curated meeting's title, or the visitor's own recording. */
function titleOf(item: Meeting): string {
  return item.sample !== null && isLb09SampleId(item.sample) ? t(`lb09.samples.names.${item.sample}.title`) : t('lb09.mine.own')
}

/** Says where a meeting stands, in words. */
function stateOf(item: Meeting): string {
  if (item.status === 'done') return t('lb09.mine.states.done')
  if (item.status === 'failed') return givesPlaceBack(item.failure) ? t('lb09.mine.states.failedGivenBack') : t('lb09.mine.states.failed')
  return item.status === 'received' ? t('lb09.mine.states.queued') : t('lb09.mine.states.working')
}

/** Writes when a meeting was sent, as the visitor's clock shows it. */
function timeOf(item: Meeting): string {
  return new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' }).format(new Date(item.created_at))
}
</script>

<template>
  <section
    class="mine"
    data-testid="my-meetings"
    aria-labelledby="lb09-mine-title"
  >
    <h2
      id="lb09-mine-title"
      class="lb-label"
    >
      {{ t('lb09.mine.title') }}
    </h2>
    <p
      v-if="mineStatus === 'loading' && mine.length === 0"
      class="note"
    >
      {{ t('lb09.mine.loading') }}
    </p>
    <p
      v-else-if="mine.length === 0"
      class="note"
    >
      {{ t('lb09.mine.none') }}
    </p>
    <ul
      v-else
      class="list"
    >
      <li
        v-for="item in mine"
        :key="item.id"
        class="row"
        data-testid="my-meeting"
        :data-status="item.status"
      >
        <span class="what">{{ titleOf(item) }}</span>
        <span class="meta">{{ t('lb09.mine.line', { time: timeOf(item), mode: t(`lb09.modes.${item.mode}`), state: stateOf(item) }) }}</span>
        <span
          v-if="meeting?.id === item.id && runMode === 'live'"
          class="note"
        >{{ t('lb09.mine.shown') }}</span>
        <button
          v-else
          type="button"
          class="open"
          :disabled="busy"
          data-testid="open-meeting"
          @click="store.openMeeting(item.id)"
        >
          {{ t('lb09.mine.open') }}
        </button>
      </li>
    </ul>
    <p class="note">
      {{ t('lb09.mine.kept') }}
    </p>
  </section>
</template>

<style scoped>
/* A card of its own in the side column, as the visitor's runs are on LB-06's and LB-07's boards. */
.mine {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 12px 14px;
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}

.note {
  font-size: 13px;
  color: var(--lb-graphite);
}

.list {
  display: grid;
  gap: 10px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.row {
  display: grid;
  gap: 3px;
  justify-items: start;
  padding-bottom: 8px;
  font-size: 13.5px;
  border-bottom: 1px solid var(--lb-rule);
}

.row:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.what {
  font-weight: 600;
}

.meta {
  font-size: 13px;
}

.open {
  padding: 5px 12px;
  margin-top: 2px;
  font: 600 13px/1.2 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: transparent;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.open:hover:not(:disabled) {
  background: var(--lb-shade);
}

.open:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
