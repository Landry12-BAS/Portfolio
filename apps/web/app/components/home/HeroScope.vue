<script setup lang="ts">
// <HomeHeroScope>: the landing page's first screen. The headline and the two ways in on the left; on the
// right, the Scope playing a real recorded run of LB-01: its nine steps as bars on one time axis, the
// model call under each with its tokens, and a playhead that crosses the run in the run's own time. The
// numbers come from shared/data/hero-trace.ts, which a test keeps equal to the recording, so what moves
// here is what happened. The bars are decoration for the eye; the list reads in full without them.
import { HERO_TRACE } from '~~/shared/data/hero-trace'
import type { HeroStep } from '~~/shared/data/hero-trace'

const { t } = useI18n()

const total = HERO_TRACE.totalMs
const seconds = (total / 1000).toFixed(1)
const steps = HERO_TRACE.steps.map((step, index) => ({ ...step, index, left: `${(step.startMs / total * 100).toFixed(2)}%`, width: `${Math.max(0.4, (step.endMs - step.startMs) / total * 100).toFixed(2)}%` }))
const calls = HERO_TRACE.steps.filter(step => step.call).length

/** Words a step's duration the way the Scope does: under ten milliseconds, milliseconds, or seconds to one decimal. */
function duration(step: HeroStep): string {
  const ms = step.endMs - step.startMs
  if (ms < 10) return t('home.hero.scope.instant')
  if (ms < 1000) return t('home.hero.scope.ms', { n: ms })
  return t('home.hero.scope.s', { n: (ms / 1000).toFixed(1) })
}

/** The right-hand cell of a step: its model and tokens when it called one, else how long it took. */
function detail(step: HeroStep): string {
  if (!step.call) return duration(step)
  return step.call.tokens ? `${step.call.model} · ${t('home.hero.scope.tokens', { in: step.call.tokens.in, out: step.call.tokens.out })}` : step.call.model
}
</script>

<template>
  <section
    class="hero"
    :aria-label="t('home.hero.label')"
  >
    <div class="intro">
      <p class="kicker">
        {{ t('home.kicker') }}
      </p>
      <h1>{{ t('home.heading') }}</h1>
      <p class="lede">
        {{ t('home.lede') }}
      </p>
      <div class="ways">
        <NuxtLinkLocale
          class="way way--solid"
          :to="{ path: '/', hash: '#systems' }"
        >
          {{ t('home.hero.pick') }}
        </NuxtLinkLocale>
        <NuxtLinkLocale
          class="way"
          :to="{ path: '/', hash: '#scope' }"
        >
          {{ t('home.hero.trace') }}
        </NuxtLinkLocale>
      </div>
      <p class="facts">
        <span class="stamp">{{ t('home.quickref.stamp') }}</span>
        <span>{{ t('home.hero.facts') }}</span>
      </p>
    </div>

    <figure
      id="scope"
      class="scope"
      :aria-label="t('home.hero.scope.title')"
    >
      <figcaption class="scope-head">
        <span class="scope-title">{{ t('home.hero.scope.title') }}</span>
        <span class="scope-run">{{ t('home.hero.scope.run') }}</span>
        <span class="scope-live"><span
          class="pulse"
          aria-hidden="true"
        />{{ t('home.hero.scope.live') }}</span>
      </figcaption>
      <p class="sr-only">
        {{ t('home.hero.scope.summary', { steps: steps.length, calls, seconds, date: HERO_TRACE.recordedAt }) }}
      </p>
      <div
        class="axis"
        aria-hidden="true"
      >
        <span>{{ t('home.hero.scope.step') }}</span>
        <span>{{ t('home.hero.scope.time', { seconds }) }}</span>
        <span class="right">{{ t('home.hero.scope.model') }}</span>
      </div>
      <ol
        class="steps"
        :style="{ '--hero-run': `${total}ms` }"
      >
        <li
          v-for="step in steps"
          :key="step.name"
          class="step"
          :data-kind="step.kind"
        >
          <span class="name"><span class="n">{{ String(step.index + 1).padStart(2, '0') }}</span> {{ step.name }}</span>
          <span
            class="lane"
            aria-hidden="true"
          ><span
            class="bar"
            :style="{ left: step.left, width: step.width }"
          /></span>
          <span class="detail">{{ detail(step) }}</span>
        </li>
        <li
          class="playhead-row"
          aria-hidden="true"
        >
          <span />
          <span class="lane lane--head"><span class="playhead" /></span>
          <span />
        </li>
      </ol>
      <div class="legend">
        <span data-kind="model">{{ t('home.hero.scope.legend.model') }}</span>
        <span data-kind="tool">{{ t('home.hero.scope.legend.tool') }}</span>
        <span data-kind="retrieval">{{ t('home.hero.scope.legend.retrieval') }}</span>
        <span data-kind="guard">{{ t('home.hero.scope.legend.guard') }}</span>
        <span class="legend-sum">{{ t('home.hero.scope.footer', { calls, steps: steps.length, seconds, date: HERO_TRACE.recordedAt }) }}</span>
      </div>
    </figure>
  </section>
</template>

<style scoped>
.hero {
  display: grid;
  grid-template-columns: minmax(0, 6fr) minmax(0, 7fr);
  gap: 32px 44px;
  align-items: center;
}

/* The first screen comes in once, top to bottom, the Scope a beat after the headline. */
.intro > *,
.scope {
  animation: rise var(--lb-motion-enter) var(--lb-ease) both;
}

.intro > :nth-child(1) { animation-delay: 40ms; }
.intro > :nth-child(2) { animation-delay: 110ms; }
.intro > :nth-child(3) { animation-delay: 180ms; }
.intro > :nth-child(4) { animation-delay: 250ms; }
.intro > :nth-child(5) { animation-delay: 320ms; }
.scope { animation-delay: 240ms; }

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.intro {
  display: grid;
  gap: 18px;
  align-content: start;
  max-width: 540px;
}

.kicker {
  font-family: var(--lb-font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--lb-signal);
}

h1 {
  font-size: clamp(2.4rem, 1.2rem + 4vw, 4.8rem);
  font-weight: 800;
  font-stretch: 118%;
  line-height: 0.96;
  letter-spacing: -0.02em;
}

.lede {
  max-width: 46ch;
  font-size: 1.125rem;
  line-height: 1.45;
  color: var(--lb-graphite);
}

.ways {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 4px;
}

.way {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 20px;
  font-size: 15px;
  font-weight: 700;
  color: var(--lb-ink);
  text-decoration: none;
  border: 1.5px solid var(--lb-ink);
  border-radius: 4px;
}

.way--solid {
  color: var(--lb-sheet);
  background: var(--lb-ink);
}

.way:hover {
  background: var(--lb-shade);
}

.way--solid:hover {
  background: var(--lb-ink-hover);
}

.facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  margin-top: 8px;
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.stamp {
  padding: 5px 9px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--lb-ink);
  border: 1.5px solid var(--lb-ink);
}

/* The instrument. */
.scope {
  display: grid;
  margin: 0;
  font-family: var(--lb-font-mono);
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-ink);
  box-shadow: 0 30px 60px -44px rgb(0 0 0 / 60%);
}

.scope-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  align-items: center;
  padding: 11px 18px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-bottom: 1.5px solid var(--lb-ink);
}

.scope-title {
  font-weight: 700;
}

.scope-run {
  color: var(--lb-graphite);
}

.scope-live {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
}

.pulse {
  width: 8px;
  height: 8px;
  background: var(--lb-signal);
  border-radius: 50%;
  animation: pulse 1.2s ease-in-out infinite;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.axis,
.step,
.playhead-row {
  display: grid;
  grid-template-columns: minmax(130px, 150px) minmax(0, 1fr) minmax(120px, 170px);
  gap: 14px;
  align-items: center;
}

.axis {
  padding: 14px 18px 6px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.axis .right,
.detail {
  text-align: right;
}

.steps {
  display: grid;
  gap: 6px;
  padding: 2px 18px 10px;
  margin: 0;
  list-style: none;
}

.step {
  min-height: 22px;
  font-size: 11px;
}

.name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.n {
  margin-right: 4px;
  color: var(--lb-graphite);
}

.detail {
  color: var(--lb-graphite);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lane {
  position: relative;
  display: block;
  height: 12px;
}

.bar {
  position: absolute;
  top: 0;
  height: 100%;
  background: var(--lb-graphite);
  border-radius: 2px;
}

.step[data-kind="model"] .bar { background: var(--lb-ch1); }
.step[data-kind="tool"] .bar { background: var(--lb-ch2); }
.step[data-kind="retrieval"] .bar { background: var(--lb-ch3); }
.step[data-kind="guard"] .bar { background: var(--lb-ch4); }

.playhead-row {
  margin-top: -6px;
}

.lane--head {
  height: 0;
}

/* The playhead crosses the lane in the run's own time (--hero-run), then starts again. */
.playhead {
  position: absolute;
  top: calc(-9 * 28px);
  bottom: 0;
  width: 2px;
  background: var(--lb-signal);
  animation: sweep var(--hero-run) linear infinite;
}

@keyframes sweep {
  from { left: 0; }
  to { left: 100%; }
}

@keyframes pulse {
  50% { opacity: 0.35; }
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 10px 18px 14px;
  font-size: 10.5px;
  color: var(--lb-graphite);
  border-top: 1px solid var(--lb-rule);
}

.legend [data-kind]::before {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  vertical-align: -1px;
  content: "";
}

.legend [data-kind="model"]::before { background: var(--lb-ch1); }
.legend [data-kind="tool"]::before { background: var(--lb-ch2); }
.legend [data-kind="retrieval"]::before { background: var(--lb-ch3); }
.legend [data-kind="guard"]::before { background: var(--lb-ch4); }

.legend-sum {
  margin-left: auto;
}

@media (prefers-reduced-motion: reduce) {
  .playhead {
    left: 77%;
    animation: none;
  }

  .pulse {
    animation: none;
  }
}

@media (max-width: 980px) {
  .hero {
    grid-template-columns: minmax(0, 1fr);
  }

  .intro {
    max-width: none;
  }
}

@media (max-width: 640px) {
  .axis,
  .step,
  .playhead-row {
    grid-template-columns: minmax(96px, 110px) minmax(0, 1fr);
  }

  .axis .right,
  .detail,
  .playhead-row > :last-child {
    display: none;
  }

  .scope-head,
  .axis,
  .steps,
  .legend {
    padding-right: 12px;
    padding-left: 12px;
  }

  .legend-sum {
    flex-basis: 100%;
    margin-left: 0;
  }
}
</style>
