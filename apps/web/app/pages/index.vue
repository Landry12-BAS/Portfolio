<script setup lang="ts">
import { systems } from '#shared/data/systems'

useSeoMeta({ title: 'Ten live AI systems' })

const phases = [
  { phase: 1 as const, title: 'Foundation', text: 'These touch all three back ends, the gateway, tracing, quotas and the eval harness. Everything after reuses them.' },
  { phase: 2 as const, title: 'Breadth', text: 'Real-time chat, vision, long documents and browser automation, on a stable base.' },
  { phase: 3 as const, title: 'Showpieces', text: 'The most complex builds come last. Eval Lab arrives with golden sets that have been growing since Phase 1.' },
]
const inPhase = (phase: 1 | 2 | 3) => systems.filter(system => system.phase === phase)
</script>

<template>
  <div class="home">
    <header class="masthead">
      <div class="intro">
        <p class="kicker">
          Ten live AI systems · One fictional company
        </p>
        <h1>A portfolio you can operate</h1>
        <p class="lede">
          Ten production-grade AI systems, built for one fictional coffee company and open to
          every visitor. Each one runs live on this site, shows every step it takes, and invites
          people to try to break it.
        </p>
      </div>
      <aside
        class="quickref"
        aria-label="Quick reference"
      >
        <span class="stamp">Phase 1 in build</span>
        <dl>
          <dt>Owner</dt>
          <dd>Landry Bodjona</dd>
          <dt>Systems</dt>
          <dd>10, on one shared platform (LB-00)</dd>
          <dt>Back ends</dt>
          <dd>Django, Flask (sync and async), Node + TypeScript</dd>
          <dt>Front end</dt>
          <dd>Nuxt (Vue 3) + Pinia, in TypeScript</dd>
          <dt>AI</dt>
          <dd>Free tiers from Groq, Workers AI and OpenRouter, behind one gateway</dd>
          <dt>Accounts</dt>
          <dd>None. Visitors stay anonymous</dd>
        </dl>
      </aside>
    </header>

    <section id="systems">
      <LbSectionHead
        num="1"
        title="Selection guide"
      />
      <p class="sec-intro">
        Filter the ten systems by back end or technique, the way engineers search a parts
        distributor. Select a part number to open its datasheet.
      </p>
      <CatalogGuide />
    </section>

    <section id="anatomy">
      <LbSectionHead
        num="2"
        title="What every system page shows"
      />
      <dl class="points">
        <div>
          <dt>The datasheet</dt>
          <dd>What the system does, the problem it solves and its operating limits, in a 30-second Brief or the full Technical version.</dd>
        </div>
        <div>
          <dt>The evaluation board</dt>
          <dd>The live demo. It opens on curated samples with cached results, and custom input runs for real within the visitor’s daily quota.</dd>
        </div>
        <div>
          <dt>The Scope</dt>
          <dd>A trace of every run: each step, tool call, token and model, with its latency and the provider that answered.</dd>
        </div>
      </dl>
    </section>

    <section id="build">
      <LbSectionHead
        num="3"
        title="Build order"
      />
      <ol class="phases">
        <li
          v-for="item in phases"
          :key="item.phase"
          :class="{ later: item.phase === 3 }"
        >
          <div class="ph-top">
            <LbPill :variant="item.phase === 1 ? 'solid' : item.phase === 3 ? 'dashed' : 'outline'">
              Phase {{ item.phase }}
            </LbPill>
            <h3>{{ item.title }}</h3>
          </div>
          <ul class="ph-list">
            <li v-if="item.phase === 1">
              <span class="ph-part">LB-00</span>Platform
            </li>
            <li
              v-for="system in inPhase(item.phase)"
              :key="system.part"
            >
              <NuxtLink
                class="ph-part"
                :to="`/systems/${system.slug}`"
              >
                {{ system.part }}
              </NuxtLink>{{ system.name }}
            </li>
          </ul>
          <p>{{ item.text }}</p>
        </li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
.home {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: clamp(44px, 6vw, 76px);
}

.masthead {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
  gap: 32px 40px;
  align-items: start;
}

.kicker {
  font-family: var(--lb-font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lb-signal);
}

h1 {
  margin-top: 12px;
  font-size: clamp(2.2rem, 1.3rem + 3.3vw, 3.9rem);
  font-weight: 800;
  font-stretch: 115%;
  line-height: 1;
  letter-spacing: -0.015em;
}

.lede {
  max-width: 58ch;
  margin-top: 18px;
  font-size: 1.125rem;
}

.quickref {
  display: grid;
  gap: 14px;
  padding: 16px 18px 18px;
  border: 1.5px solid var(--lb-ink);
}

.stamp {
  justify-self: start;
  padding: 5px 9px;
  font-family: var(--lb-font-mono);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  border: 1.5px solid var(--lb-ink);
}

.quickref dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 7px 14px;
  font-size: 14px;
  line-height: 1.4;
}

.quickref dt {
  padding-top: 3px;
  font-family: var(--lb-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.quickref dd {
  margin: 0;
}

.sec-intro {
  max-width: 70ch;
  margin-bottom: 22px;
  color: var(--lb-graphite);
}

.points {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 22px 32px;
}

.points dt {
  margin-bottom: 4px;
  font-size: 1rem;
  font-weight: 800;
  font-stretch: 112%;
}

.points dd {
  max-width: 60ch;
  margin: 0;
  color: var(--lb-graphite);
}

.phases {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  padding: 0;
  list-style: none;
}

.phases > li {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  align-content: start;
  padding: 16px 18px;
  border: 1.5px solid var(--lb-ink);
}

.phases > li.later {
  border-style: dashed;
}

.ph-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.ph-top h3 {
  font-size: 1.15rem;
  font-weight: 800;
  font-stretch: 112%;
}

.ph-list {
  display: grid;
  gap: 5px;
  padding: 0;
  font-size: 14px;
  list-style: none;
}

.ph-part {
  margin-right: 8px;
  font-family: var(--lb-font-mono);
  font-size: 11.5px;
  font-weight: 700;
}

.phases p {
  font-size: 14px;
  color: var(--lb-graphite);
}

@media (max-width: 900px) {
  .masthead,
  .points,
  .phases {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
