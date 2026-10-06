<script setup lang="ts">
// <LiveCalendar>: the roastery's calendar next to the chat, with the days to choose from and the
// slots of the chosen day. A slot is free, held (by a conversation, for five minutes) or booked, and
// each state is an icon and a word, never a colour alone. It moves as conversations do: a change the
// server sends is marked for a few seconds and announced politely, in words, to a screen reader. A hold
// whose time has passed is shown as free at once, since the booking rules read it that way too, even if
// the server's sweep (once a minute) has not said so yet. The slots this conversation holds or has
// booked say "for you". The days are a group of radio buttons, so the arrow keys move between them
// and the Tab key passes the whole group in one stop.
import { LbIcon } from '@lb/icons'
import type { IconName } from '@lb/icons'
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'

import { dayToShow, groupByDay, pragueDate, showSlot } from '../calendar'
import type { SlotMap } from '../calendar'
import { formatClock, formatDayLong, formatDayShort, formatSession } from '../format'
import type { Offering } from '../schemas'
import type { ChangeNote } from '../store'

/** How a slot is worded and drawn: its state, and whether it is this conversation's own. */
type SlotLook = 'free' | 'held' | 'booked' | 'heldMine' | 'bookedMine'

const props = defineProps<{
  slots: SlotMap
  /** The server's clock in Unix milliseconds, which moves every second. */
  now: number
  status: 'idle' | 'loading' | 'ready' | 'failed'
  /** The last change to the calendar, which is told to a screen reader. */
  lastChange: ChangeNote | undefined
  /** The slots that changed a moment ago, which are marked. */
  recentlyChanged: ReadonlySet<number>
  offerings: readonly Offering[]
  /** True for a replay, whose calendar is the recording's. */
  replay: boolean
  /** Writes an offering's name in the visitor's language. */
  titleOf: (key: string) => string
}>()

const emit = defineEmits<{ reload: [] }>()

const { t, locale } = useI18n()
const groupName = useId()
const chosen = ref<string>()

const days = computed(() => groupByDay(props.slots, props.now))
// The day the visitor chose; until they choose, the day with their own slot, else the first with a free one.
const shownDate = computed(() => days.value.find(day => day.date === chosen.value)?.date ?? dayToShow(days.value))
const shownDay = computed(() => days.value.find(day => day.date === shownDate.value))
const icons: Readonly<Record<SlotLook, IconName>> = { free: 'check', held: 'clock', booked: 'booking', heldMine: 'clock', bookedMine: 'booking' }

/** Says how a slot looks now: free, held or booked, and whether it is the visitor's own. */
function lookOf(state: 'free' | 'held' | 'booked', mine: boolean): SlotLook {
  if (state === 'held') return mine ? 'heldMine' : 'held'
  if (state === 'booked') return mine ? 'bookedMine' : 'booked'
  return 'free'
}

/** Writes the counts of a day's slots in words, for a screen reader to read with the day. */
function countsOf(day: { free: number, held: number, booked: number }): string {
  return t('lb02.calendar.counts', { free: day.free, held: day.held, booked: day.booked })
}

// What a screen reader is told when the calendar moves: one slot in full, several by number, a reload in a sentence.
const announcement = computed(() => {
  const note = props.lastChange
  if (!note) return ''
  if (note.cause === 'reset') return t('lb02.calendar.reset')
  if (note.cause === 'reconnect') return t('lb02.calendar.reloaded')
  const first = note.slots[0]
  if (note.slots.length !== 1 || !first) return t('lb02.calendar.changedMany', { count: note.slots.length })
  const shown = showSlot(first, props.now)
  const status = t(`lb02.calendar.status.${lookOf(shown.status, first.mine)}`).toLocaleLowerCase(locale.value)
  return t('lb02.calendar.changedOne', {
    offering: props.titleOf(first.offering),
    day: formatDayShort(pragueDate(first.starts_at), locale.value),
    time: formatClock(first.starts_at, locale.value),
    status,
  })
})
</script>

<template>
  <section
    class="calendar"
    :aria-label="t('lb02.calendar.title')"
    data-testid="calendar"
  >
    <h2 class="lb-label">
      {{ t('lb02.calendar.title') }}
    </h2>
    <p class="help">
      {{ replay ? t('lb02.calendar.recorded') : t('lb02.calendar.help') }}
    </p>

    <ul
      class="legend"
      :aria-label="t('lb02.calendar.legend')"
    >
      <li
        v-for="state in (['free', 'held', 'booked'] as const)"
        :key="state"
        :data-state="state"
      >
        <LbIcon
          :name="icons[state]"
          :size="14"
          tone="mono"
        />
        {{ t(`lb02.calendar.status.${state}`) }}
      </li>
    </ul>

    <p
      v-if="status === 'loading' && days.length === 0"
      class="note"
      role="status"
    >
      {{ t('lb02.calendar.loading') }}
    </p>
    <div
      v-else-if="status === 'failed' && days.length === 0"
      class="failed"
      role="alert"
      data-testid="calendar-failed"
    >
      <p>{{ t('lb02.calendar.failed') }}</p>
      <button
        type="button"
        class="button"
        @click="emit('reload')"
      >
        {{ t('lb02.calendar.reload') }}
      </button>
    </div>
    <p
      v-else-if="days.length === 0"
      class="note"
    >
      {{ t('lb02.calendar.empty') }}
    </p>

    <template v-else>
      <fieldset class="days">
        <legend class="lb-sr-only">
          {{ t('lb02.calendar.daysLabel') }}
        </legend>
        <label
          v-for="day in days"
          :key="day.date"
          class="day"
          :class="{ chosen: day.date === shownDate }"
        >
          <input
            type="radio"
            class="lb-sr-only"
            :name="groupName"
            :checked="day.date === shownDate"
            :aria-describedby="`${groupName}-${day.date}`"
            :data-testid="`day-${day.date}`"
            @change="chosen = day.date"
          >
          <span class="name">{{ formatDayShort(day.date, locale) }}</span>
          <span
            class="free"
            aria-hidden="true"
          >
            <LbIcon
              name="check"
              :size="12"
              tone="mono"
            />
            {{ day.free }}
          </span>
          <span
            v-if="day.hasMine"
            class="own-mark"
            aria-hidden="true"
          >
            <LbIcon
              name="success"
              :size="12"
              tone="mono"
            />
          </span>
          <span
            :id="`${groupName}-${day.date}`"
            class="lb-sr-only"
          >{{ countsOf(day) }}<template v-if="day.hasMine">. {{ t('lb02.calendar.dayMarker') }}</template></span>
        </label>
      </fieldset>

      <div
        v-if="shownDay"
        class="slots"
      >
        <h3 class="day-title">
          {{ formatDayLong(shownDay.date, locale) }}
        </h3>
        <p class="counts">
          {{ countsOf(shownDay) }}
        </p>
        <ul
          class="rows"
          data-testid="slots"
        >
          <li
            v-for="item in shownDay.slots"
            :key="item.slot.id"
            class="row"
            :class="{ fresh: recentlyChanged.has(item.slot.id), mine: item.slot.mine && item.status !== 'free' }"
            :data-state="item.status"
            :data-slot="item.slot.id"
          >
            <span class="when">{{ formatSession(item.slot.starts_at, item.slot.ends_at, locale) }}</span>
            <span class="what">{{ titleOf(item.slot.offering) }}</span>
            <span class="state">
              <LbIcon
                :name="icons[lookOf(item.status, item.slot.mine)]"
                :size="14"
                tone="mono"
              />
              {{ t(`lb02.calendar.status.${lookOf(item.status, item.slot.mine)}`) }}
            </span>
            <span
              v-if="item.lapsed"
              class="lapsed"
            >{{ t('lb02.calendar.lapsed') }}</span>
          </li>
        </ul>
      </div>
    </template>

    <div
      class="lb-sr-only"
      role="status"
      aria-live="polite"
      data-testid="calendar-announcement"
    >
      <p :key="lastChange?.sequence ?? 0">
        {{ announcement }}
      </p>
    </div>

    <section
      v-if="offerings.length > 0"
      class="offerings"
      :aria-label="t('lb02.calendar.offerings')"
    >
      <h3 class="lb-label">
        {{ t('lb02.calendar.offerings') }}
      </h3>
      <dl>
        <div
          v-for="offering in offerings"
          :key="offering.key"
        >
          <dt>{{ titleOf(offering.key) }}</dt>
          <dd>
            {{ t('lb02.calendar.offering.minutes', { minutes: offering.duration_minutes }) }},
            {{ t('lb02.calendar.offering.capacity', { capacity: offering.capacity }) }}
          </dd>
        </div>
      </dl>
    </section>
  </section>
</template>

<style scoped>
/* The calendar lays itself out by its own width, not the window's: beside the phone on a wide board, alone
   on a narrow one, so only its own width says how much room its rows have. */
.calendar {
  container: lb02-calendar / inline-size;
  display: grid;
  align-content: start;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.help,
.note,
.counts {
  font-size: 13px;
  color: var(--lb-graphite);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 0;
  margin: 0;
  font-size: 12.5px;
  list-style: none;
}

.legend li,
.state {
  display: inline-flex;
  gap: 5px;
  align-items: center;
}

.failed {
  display: grid;
  gap: 8px;
  justify-items: start;
  font-size: 14px;
}

.button {
  padding: 7px 12px;
  font: 600 13px/1 var(--lb-font-sans);
  color: var(--lb-ink);
  cursor: pointer;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
}

/* The days: cells of one width, in as many columns as fit. */
.days {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(6rem, 1fr));
  gap: 6px;
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}

.day {
  position: relative;
  display: grid;
  gap: 1px;
  min-width: 0;
  padding: 5px 8px;
  cursor: pointer;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
}

.day:hover {
  border-color: var(--lb-ink);
}

.day.chosen {
  background: var(--lb-shade);
  border-color: var(--lb-ink);
}

.day:has(input:focus-visible) {
  outline: 2px solid var(--lb-signal);
  outline-offset: 2px;
}

.name {
  font-size: 12.5px;
  font-weight: 700;
}

.free {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  font-family: var(--lb-font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--lb-graphite);
}

/* On the count's line, which is always short, so it never covers the day's name. Its class is its own:
   `.mine` marks the visitor's own row in the list, which must stay in the list's flow. */
.own-mark {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: inline-flex;
}

.slots {
  display: grid;
  gap: 6px;
}

.day-title {
  font-size: 15px;
  font-weight: 700;
}

.rows {
  display: grid;
  padding: 0;
  margin: 0;
  list-style: none;
  border-top: 1px solid var(--lb-rule);
}

.row {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) auto;
  gap: 2px 10px;
  align-items: baseline;
  padding: 7px 8px;
  font-size: 13.5px;
  border-bottom: 1px solid var(--lb-rule);
  border-left: 4px solid transparent;
}

.row.fresh {
  background: var(--lb-shade);
  border-left-color: var(--lb-signal);
}

.row.mine .state {
  font-weight: 700;
}

.what {
  overflow-wrap: anywhere;
}

.row[data-state="booked"] .what {
  color: var(--lb-graphite);
}

.when {
  font-family: var(--lb-font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.lapsed {
  grid-column: 2 / -1;
  font-size: 12px;
  color: var(--lb-graphite);
}

.offerings {
  display: grid;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--lb-rule);
}

.offerings dl {
  display: grid;
  gap: 6px;
  margin: 0;
  font-size: 13px;
}

.offerings dt {
  font-weight: 700;
}

.offerings dd {
  margin: 0;
  color: var(--lb-graphite);
}

/* Too narrow for three columns: the time goes on a line of its own, above the name and the state. */
@container lb02-calendar (max-width: 380px) {
  .row {
    grid-template-columns: 1fr auto;
  }

  .when {
    grid-column: 1 / -1;
  }
}
</style>
