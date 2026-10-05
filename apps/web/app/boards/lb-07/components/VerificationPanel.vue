<script setup lang="ts">
// <VerificationPanel>: the red-then-green verification of the generated test, shown plainly. First the
// verdict in words (kept, passing, discarded and why, or not verified) and what it means; then the three
// passes the verdict rests on, as a table: the run itself with the bugs on in Chromium, the same plan in the
// second engine with the bugs on, and the plan on the clean shop. Each pass is red or green in words and with
// an icon, never by colour alone, with whether every step passed and how many bug findings it made. The
// second engine is Chromium wearing Firefox's user agent, and the panel says so.
import type { Lb07VerificationPass } from '@lb/contracts'
import { LbIcon } from '@lb/icons'
import { storeToRefs } from 'pinia'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLb07Store } from '../store'
import { useLb07Words } from '../words'

defineProps<{
  /** The Brief reading leaves out each pass's time. */
  brief: boolean
}>()

const { t } = useI18n()
const words = useLb07Words()
const { report } = storeToRefs(useLb07Store())
const id = useId()

const verification = computed(() => report.value?.verification)
const rows = computed(() => {
  const found = verification.value
  if (!found) return []
  return [
    { key: 'red', pass: found.red },
    { key: 'cross', pass: found.cross },
    { key: 'green', pass: found.green },
  ] as const
})

/** Tells whether a pass is red: a bug finding, or a step that did not pass. */
function isRed(pass: Lb07VerificationPass): boolean {
  return pass.findings > 0 || !pass.stepsPassed
}
</script>

<template>
  <section
    v-if="verification"
    class="lb7-panel"
    :aria-labelledby="`${id}-title`"
    data-testid="verification"
  >
    <h2 :id="`${id}-title`">
      {{ t('lb07.verification.title') }}
    </h2>
    <p
      class="verdict"
      data-testid="verdict"
      :data-verdict="verification.verdict"
    >
      <LbIcon
        :name="verification.verdict === 'kept' || verification.verdict === 'passing' ? 'success' : verification.verdict === 'not_verified' ? 'info' : 'error'"
        :size="20"
        tone="mono"
      />
      <span>{{ words.verdictWord(verification.verdict) }}</span>
    </p>
    <p>{{ words.verdictNote(verification.verdict) }}</p>
    <p class="lb7-hint">
      {{ t('lb07.verification.explain') }}
    </p>
    <div
      class="lb7-table-wrap"
      tabindex="0"
      role="region"
      :aria-label="t('lb07.verification.caption')"
    >
      <table
        class="lb7-table"
        data-testid="passes"
      >
        <caption class="lb7-hint">
          {{ t('lb07.verification.caption') }}
        </caption>
        <thead>
          <tr>
            <th scope="col">
              {{ t('lb07.verification.pass') }}
            </th>
            <th scope="col">
              {{ t('lb07.verification.result') }}
            </th>
            <th scope="col">
              {{ t('lb07.verification.stepsColumn') }}
            </th>
            <th
              scope="col"
              class="lb7-nums"
            >
              {{ t('lb07.verification.findingsColumn') }}
            </th>
            <th
              v-if="!brief"
              scope="col"
              class="lb7-nums"
            >
              {{ t('lb07.verification.timeColumn') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.key"
            :data-pass="row.key"
            :data-result="row.pass === null ? 'none' : isRed(row.pass) ? 'red' : 'green'"
          >
            <th scope="row">
              {{ t(`lb07.verification.passes.${row.key}`) }}
            </th>
            <td>
              <span
                v-if="row.pass === null"
                class="lb7-hint"
              >{{ t('lb07.verification.notRun') }}</span>
              <span
                v-else
                class="lb7-status"
              >
                <LbIcon
                  :name="isRed(row.pass) ? 'error' : 'success'"
                  :size="14"
                  tone="mono"
                />
                {{ isRed(row.pass) ? t('lb07.verification.red') : t('lb07.verification.green') }}
              </span>
            </td>
            <td>{{ row.pass === null ? '–' : row.pass.stepsPassed ? t('lb07.verification.allPassed') : t('lb07.verification.notAllPassed') }}</td>
            <td class="lb7-nums">
              {{ row.pass === null ? '–' : row.pass.findings }}
            </td>
            <td
              v-if="!brief"
              class="lb7-nums"
            >
              {{ row.pass === null ? '–' : words.duration(row.pass.durationMs) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p
      class="lb7-hint"
      data-testid="second-engine-note"
    >
      {{ t('lb07.sandbox') }}
    </p>
  </section>
</template>

<style scoped>
.verdict {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 18px;
  font-weight: 700;
}
</style>
