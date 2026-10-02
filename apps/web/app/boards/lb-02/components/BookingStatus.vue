<script setup lang="ts">
// <BookingStatus>: where the booking stands, on the phone's screen above the message field: the slot
// held for the visitor with the time left to confirm it, or the booking with its code. The countdown
// is read from the server's own clock (the calendar's snapshot says how far it is from the page's, and
// the board passes the server's time on), is drawn every second but announced only twice, when one minute is left and when the hold has run out,
// so a screen reader is not read a number a second. A replay shows what the hold was, not a clock that
// ran out long ago.
import { LbIcon } from '@lb/icons'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { countdown, formatClockSeconds, formatSession, formatWhen } from '../format'
import type { Booking, Hold } from '../wire'

const props = defineProps<{
  hold: Hold | null
  booking: Booking | null
  /** The server's clock in Unix milliseconds, which moves every second. */
  now: number
  /** True for a replay, whose hold ran out long ago and is shown as it was. */
  replay: boolean
  /** Writes an offering's name in the visitor's language. */
  titleOf: (key: string) => string
  /** Where the recorded confirmation is on the page. */
  emailHref: string
}>()

const { t, locale } = useI18n()

const left = computed(() => (props.hold ? countdown(Date.parse(props.hold.expires_at), props.now) : undefined))
const ranOut = computed(() => !props.replay && left.value !== undefined && left.value.totalSeconds === 0)
const announcement = ref('')

// The countdown is announced when one minute is left and when it ends, and not between.
watch(() => left.value?.totalSeconds, (seconds, before) => {
  if (props.replay || seconds === undefined) return
  if (seconds === 0) announcement.value = t('lb02.hold.ranOut')
  else if (seconds <= 60 && (before === undefined || before > 60)) announcement.value = t('lb02.hold.lastMinute')
})
</script>

<template>
  <section
    v-if="hold || booking"
    class="status"
    :class="{ booked: booking !== null }"
    :aria-label="booking ? t('lb02.booking.title') : t('lb02.hold.title')"
    data-testid="booking-status"
  >
    <template v-if="booking">
      <p class="head">
        <LbIcon
          name="success"
          :size="16"
          tone="mono"
        />
        {{ t('lb02.booking.title') }}
      </p>
      <p class="what">
        {{ titleOf(booking.offering) }}, {{ formatWhen(booking.starts_at, locale) }}
      </p>
      <dl class="facts">
        <div>
          <dt>{{ t('lb02.booking.code') }}</dt>
          <dd
            class="code"
            data-testid="booking-code"
          >
            {{ booking.code }}
          </dd>
        </div>
        <div>
          <dt>{{ t('lb02.booking.party', { count: booking.party_size }) }}</dt>
          <dd>{{ formatSession(booking.starts_at, booking.ends_at, locale) }}</dd>
        </div>
      </dl>
      <a
        class="link"
        :href="emailHref"
      >{{ t('lb02.email.title') }}</a>
    </template>
    <template v-else-if="hold">
      <p class="head">
        <LbIcon
          name="clock"
          :size="16"
          tone="mono"
        />
        {{ t('lb02.hold.title') }}
      </p>
      <p class="what">
        {{ titleOf(hold.offering) }}, {{ formatWhen(hold.starts_at, locale) }}
      </p>
      <p
        v-if="replay"
        class="timer"
      >
        {{ t('lb02.hold.recorded') }}
      </p>
      <p
        v-else-if="ranOut"
        class="timer"
        data-testid="hold-ran-out"
      >
        {{ t('lb02.hold.ranOut') }}
      </p>
      <p
        v-else-if="left"
        class="timer"
        role="timer"
        data-testid="hold-timer"
      >
        <span class="time">{{ t('lb02.hold.left', { minutes: left.minutes, seconds: left.seconds }) }}</span>
        <span class="until">{{ t('lb02.hold.until', { time: formatClockSeconds(hold.expires_at, locale) }) }}</span>
      </p>
    </template>
    <p
      class="lb-sr-only"
      role="status"
    >
      {{ announcement }}
    </p>
  </section>
</template>

<style scoped>
.status {
  display: grid;
  gap: 4px;
  padding: 10px 14px;
  margin: 0 12px;
  background: var(--lb-shade);
  border: 1.5px dashed var(--lb-signal);
  border-radius: 14px;
}

.status.booked {
  border-style: solid;
}

.head {
  display: flex;
  gap: 6px;
  align-items: center;
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.what {
  font-size: 14px;
  font-weight: 700;
}

.timer {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  align-items: baseline;
  font-size: 13px;
}

.time {
  font-family: var(--lb-font-mono);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.until {
  font-size: 12px;
  color: var(--lb-graphite);
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  font-size: 13px;
}

.facts dt {
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.facts dd {
  margin: 0;
}

.code {
  font-family: var(--lb-font-mono);
  font-weight: 700;
  letter-spacing: 0.06em;
}

.link {
  justify-self: start;
  font-size: 13px;
  color: var(--lb-ink);
}
</style>
