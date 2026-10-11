<script setup lang="ts">
// <HomeTileScene>: the small moving picture on a system's tile, one scene per system: tickets being cited,
// a calendar filling, an invoice's fields found, a contract's risky clauses marked, a chart with its query,
// an incident's spike and recovery, a browser being driven, a workflow lighting up, a waveform, two scores
// compared. Every scene is drawn with the tokens and moves with CSS alone, and stands still for a visitor
// who asked for less motion. It is decoration: the tile's words carry the meaning, so the scene is hidden
// from assistive technology.
defineProps<{
  /** Which system's scene to draw: its slug, lb-01 to lb-10. Any other draws the last scene. */
  slug: string
}>()

// LB-02's calendar: four weeks of seven days, with the booked ones.
const calendar = [0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 2, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0]
// LB-09's waveform, as bar heights in pixels.
const wave = [22, 48, 70, 40, 58, 30, 64, 44, 20, 52, 36, 60]
</script>

<template>
  <span
    class="scene"
    :data-scene="slug"
    aria-hidden="true"
  >
    <template v-if="slug === 'lb-01'">
      <span class="lines">
        <span style="width: 78%" /><span
          class="lit"
          style="width: 60%"
        /><span style="width: 70%" /><span style="width: 40%" />
      </span>
      <span class="dot" />
      <span class="note">cited: order BB-1040</span>
    </template>

    <template v-else-if="slug === 'lb-02'">
      <span class="calendar">
        <span
          v-for="(day, index) in calendar"
          :key="index"
          :class="{ booked: day > 0, held: day === 2 }"
        />
      </span>
    </template>

    <template v-else-if="slug === 'lb-03'">
      <span class="paper">
        <span style="width: 60%" /><span style="width: 45%" /><span style="width: 70%" />
        <span class="field" /><span class="total" />
      </span>
      <span class="note">total 667 CZK</span>
    </template>

    <template v-else-if="slug === 'lb-04'">
      <span class="clauses">
        <span style="width: 92%" />
        <span class="pair"><span style="width: 30%" /><span
          class="risk"
          style="width: 42%"
        /></span>
        <span style="width: 84%" />
        <span class="pair"><span
          class="risk"
          style="width: 55%"
        /><span style="width: 20%" /></span>
        <span style="width: 64%" />
      </span>
      <span class="note">2 risks · clause 7.2, 11.4</span>
    </template>

    <template v-else-if="slug === 'lb-05'">
      <span class="chart">
        <span style="height: 40%" /><span style="height: 62%" /><span style="height: 48%" /><span style="height: 90%" /><span style="height: 70%" /><span
          class="peak"
          style="height: 100%"
        />
      </span>
      <span class="query">SELECT month, SUM(total) … <span class="caret" /></span>
    </template>

    <template v-else-if="slug === 'lb-06'">
      <svg
        class="spark"
        viewBox="0 0 220 90"
        preserveAspectRatio="none"
      >
        <line
          x1="0"
          y1="72"
          x2="220"
          y2="72"
          class="base"
        />
        <polyline
          points="0,70 30,68 60,66 80,64 95,20 110,30 125,18 140,62 170,66 200,68 220,67"
          class="trace"
        />
        <circle
          cx="140"
          cy="62"
          r="5"
          class="mark"
        />
      </svg>
      <span class="note">fix approved · recovered</span>
    </template>

    <template v-else-if="slug === 'lb-07'">
      <span class="browser">
        <span class="chrome" />
        <span class="button" />
        <span class="target" />
        <span class="cursor" />
      </span>
      <span class="note">bug found · test written</span>
    </template>

    <template v-else-if="slug === 'lb-08'">
      <span class="flow">
        <span class="node" /><span class="edge" /><span
          class="node"
          style="animation-delay: 0.7s"
        /><span class="edge" /><span
          class="node"
          style="animation-delay: 1.4s"
        /><span class="edge" /><span
          class="node node--fails"
          style="animation-delay: 2.1s"
        />
      </span>
    </template>

    <template v-else-if="slug === 'lb-09'">
      <span class="wave">
        <span
          v-for="(height, index) in wave"
          :key="index"
          :class="{ lit: index === 2 || index === 6 }"
          :style="{ height: `${height}px`, animationDelay: `${index * 0.1}s` }"
        />
      </span>
      <span class="note">action at 00:41</span>
    </template>

    <template v-else>
      <span class="scores">
        <span class="label">production · 0.81</span>
        <span class="score"><span style="width: 81%" /><span
          class="ci"
          style="left: 70%; width: 22%"
        /></span>
        <span class="label lit">your prompt · 0.88</span>
        <span class="score"><span
          class="lit"
          style="width: 88%"
        /><span
          class="ci"
          style="left: 79%; width: 18%"
        /></span>
      </span>
    </template>
  </span>
</template>

<style scoped>
.scene {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  height: 122px;
  margin: 0 12px;
  overflow: hidden;
  border-top: 1px solid var(--lb-rule);
  border-bottom: 1px solid var(--lb-rule);
}

.note {
  position: absolute;
  right: 0;
  bottom: 8px;
  font-family: var(--lb-font-mono);
  font-size: 9px;
  color: var(--lb-signal);
}

/* LB-01: lines of a reply, one cited, and the pipeline's dot running over them. */
.lines {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px;
}

.lines > span {
  height: 8px;
  background: var(--lb-rule);
}

.lines > .lit {
  background: var(--lb-signal);
}

.dot {
  position: absolute;
  top: 14px;
  left: 0;
  width: 8px;
  height: 8px;
  background: var(--lb-ink);
  border-radius: 50%;
  animation: travel 3s ease-in-out infinite;
}

@keyframes travel {
  0% { transform: translate(0, 0); }
  45% { transform: translate(120px, 0); }
  55% { transform: translate(120px, 36px); }
  100% { transform: translate(0, 36px); }
}

/* LB-02: a month of tastings, one held while the visitor decides. */
.calendar {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  grid-auto-rows: 20px;
  gap: 4px;
}

.calendar > span {
  background: var(--lb-shade);
}

.calendar > .booked {
  background: var(--lb-signal);
}

.calendar > .held {
  animation: blink 1.4s ease-in-out infinite;
}

/* LB-03: a page of an invoice, white in both themes, with a field found and the total marked. */
.paper {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-self: center;
  box-sizing: border-box;
  width: 90px;
  height: 104px;
  padding: 10px 8px;
  background: var(--lb-paper);
  border: 1px solid var(--lb-rule);
}

.paper > span {
  height: 5px;
  background: #d5dbe1;
}

.paper > .field {
  position: absolute;
  top: 46px;
  left: 6px;
  width: 50px;
  height: 14px;
  background: transparent;
  border: 1.5px dashed var(--lb-page-line);
}

.paper > .total {
  position: absolute;
  right: 6px;
  bottom: 8px;
  width: 34px;
  height: 12px;
  background: var(--lb-page-marker);
  border: 1.5px solid var(--lb-page-line);
}

/* LB-04: the lines of a contract, two spans of them marked as risks. */
.clauses {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.clauses > span,
.pair > span {
  display: block;
  height: 7px;
  background: var(--lb-rule);
}

.pair {
  display: flex;
  gap: 6px;
  background: none;
}

.risk {
  background: var(--lb-marker);
}

/* LB-05: a chart of sales by month and the query being written. */
.chart {
  display: flex;
  gap: 6px;
  align-items: flex-end;
  height: 64px;
  margin-top: 10px;
}

.chart > span {
  width: 18px;
  background: var(--lb-signal);
}

.chart > .peak {
  background: var(--lb-series-2);
}

.query {
  margin-top: 8px;
  font-family: var(--lb-font-mono);
  font-size: 9.5px;
  color: var(--lb-graphite);
}

.caret {
  display: inline-block;
  width: 7px;
  height: 12px;
  vertical-align: -2px;
  background: var(--lb-ink);
  animation: blink 0.9s steps(2) infinite;
}

/* LB-06: latency during an incident, and the recovery. */
.spark {
  width: 100%;
  height: 90px;
}

.base {
  stroke: var(--lb-rule);
  stroke-width: 1;
}

.trace {
  fill: none;
  stroke: var(--lb-series-2);
  stroke-width: 2.5;
}

.mark {
  fill: var(--lb-signal);
}

/* LB-07: a browser window and the agent's cursor finding the button that misbehaves. */
.browser {
  position: relative;
  box-sizing: border-box;
  width: 150px;
  height: 92px;
  align-self: center;
  border: 1.5px solid var(--lb-ink);
}

.chrome {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: 12px;
  background: var(--lb-shade);
  border-bottom: 1.5px solid var(--lb-ink);
}

.button {
  position: absolute;
  top: 28px;
  left: 14px;
  width: 44px;
  height: 16px;
  border: 1.5px solid var(--lb-ink);
}

.target {
  position: absolute;
  top: 54px;
  left: 84px;
  width: 44px;
  height: 16px;
  background: var(--lb-signal);
}

.cursor {
  position: absolute;
  top: 30px;
  left: 20px;
  box-sizing: border-box;
  width: 12px;
  height: 12px;
  background: var(--lb-sheet);
  border: 2px solid var(--lb-ink);
  border-radius: 50%;
  animation: click 3.2s ease-in-out infinite;
}

@keyframes click {
  0%, 100% { transform: translate(0, 0); }
  40%, 50% { transform: translate(70px, 26px) scale(1); }
  45% { transform: translate(70px, 26px) scale(0.7); }
}

/* LB-08: a workflow's steps lighting up in turn, the last one made to fail. */
.flow {
  display: flex;
  gap: 0;
  align-items: center;
  padding: 0 6px;
}

.node {
  width: 30px;
  height: 30px;
  background: var(--lb-signal);
  border: 1.5px solid var(--lb-ink);
  animation: light 2.8s linear infinite both;
}

.node--fails {
  background: transparent;
  border: 1.5px dashed var(--lb-series-2);
}

.edge {
  flex: 1;
  height: 1.5px;
  background: var(--lb-ink);
}

@keyframes light {
  0%, 100% { opacity: 0.35; }
  20%, 40% { opacity: 1; }
}

/* LB-09: a minute of a meeting, two moments of it marked. */
.wave {
  display: flex;
  gap: 4px;
  align-items: center;
  justify-content: center;
}

.wave > span {
  width: 5px;
  background: var(--lb-ink);
  border-radius: 2px;
  animation: bounce 1.3s ease-in-out infinite;
}

.wave > .lit {
  background: var(--lb-signal);
}

@keyframes bounce {
  50% { transform: scaleY(0.35); }
}

/* LB-10: production's score and the visitor's, with their intervals. */
.scores {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.scores > .label {
  margin-top: 8px;
  font-family: var(--lb-font-mono);
  font-size: 9px;
  color: var(--lb-graphite);
}

.scores > .label.lit {
  color: var(--lb-signal);
}

.score {
  position: relative;
  display: block;
  height: 10px;
  background: var(--lb-shade);
}

.score > span {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: var(--lb-ink);
}

.score > .lit {
  background: var(--lb-signal);
}

.score > .ci {
  top: 4px;
  bottom: auto;
  height: 2px;
  background: var(--lb-graphite);
}

@keyframes blink {
  50% { opacity: 0.3; }
}

@media (prefers-reduced-motion: reduce) {
  .dot,
  .held,
  .caret,
  .cursor,
  .node,
  .wave > span {
    animation: none;
  }
}

@media (max-width: 640px) {
  .scene {
    height: 72px;
    margin: 0 10px;
  }

  .note,
  .query {
    display: none;
  }

  .calendar {
    grid-auto-rows: 12px;
    gap: 3px;
  }

  .paper {
    width: 48px;
    height: 54px;
    padding: 6px 5px;
    gap: 4px;
  }

  .paper > span {
    height: 3px;
  }

  .paper > .field {
    top: 24px;
    left: 4px;
    width: 28px;
    height: 9px;
  }

  .paper > .total {
    right: 4px;
    bottom: 5px;
    width: 18px;
    height: 7px;
  }

  .chart {
    height: 48px;
    margin-top: 0;
  }

  .chart > span {
    width: 14px;
  }

  .spark {
    height: 56px;
  }

  .browser {
    width: 96px;
    height: 50px;
  }

  .chrome {
    height: 8px;
  }

  .button {
    top: 16px;
    left: 8px;
    width: 28px;
    height: 10px;
  }

  .target {
    top: 30px;
    left: 54px;
    width: 28px;
    height: 10px;
  }

  .cursor {
    display: none;
  }

  .node {
    width: 20px;
    height: 20px;
  }

  .wave > span {
    width: 4px;
    transform: scaleY(0.6);
  }

  .scores > .label {
    margin-top: 4px;
  }
}
</style>
