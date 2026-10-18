<script setup lang="ts">
// All content comes from the translated technical datasheets, never decorative metrics.
const { t } = useI18n()
const datasheets = useDatasheets()
const order = ['lb-01', 'lb-06', 'lb-10', 'lb-05']
const featured = computed(() => order.flatMap(slug => datasheets.value.filter(s => s.slug === slug)))
</script>

<template>
  <section
    id="featured"
    class="featured"
    aria-labelledby="featured-heading"
  >
    <div class="featured-head">
      <div>
        <p class="eyebrow">{{ t('home.featured.kicker') }}</p>
        <h2 id="featured-heading">
          {{ t('home.featured.title') }}
        </h2>
      </div>
      <NuxtLinkLocale class="see-all" :to="{ path: '/', hash: '#systems' }">
        {{ t('home.featured.all') }}
        <span aria-hidden="true">→</span>
      </NuxtLinkLocale>
    </div>
    <p class="featured-summary">{{ t('home.featured.intro') }}</p>
    <ol class="cards">
      <li
        v-for="(system, i) in featured"
        :key="system.part"
      >
        <NuxtLinkLocale
          class="card"
          :class="`card--${system.slug}`"
          :to="`/systems/${system.slug}`"
          :aria-label="t('home.featured.open', { name: system.name })"
        >
          <div class="card-beam" aria-hidden="true" />
          <div class="card-head">
            <span class="card-icon" aria-hidden="true">{{ ['◈', '△', '✧', '▥'][i] }}</span>
            <span class="card-part">{{ system.part }}</span>
            <span class="demo-badge"><span class="demo-dot" />{{ t('home.featured.preview') }}</span>
          </div>
          <div class="scene-wrap">
            <HomeTileScene :slug="system.slug" />
          </div>
          <div class="card-copy">
            <h3>{{ system.name }}</h3>
            <p>{{ system.function }}</p>
            <div class="tag-row">
              <span
                v-for="tag in system.tags.slice(0, 3)"
                :key="tag"
                class="tag"
              >{{ tag }}</span>
            </div>
          </div>
          <div class="card-foot">
            <span>{{ system.runtime }}</span>
            <strong>
              {{ t('home.featured.explore') }}
              <span aria-hidden="true">↗</span>
            </strong>
          </div>
        </NuxtLinkLocale>
      </li>
    </ol>
    <p class="featured-disclaimer">
      {{ t('home.featured.disclaimer') }}
    </p>
  </section>
</template>

<style scoped>
.featured {
  display: grid;
  gap: 16px;
  min-width: 0;
  padding: 0;
  color: #f5f9ff;
  border: 0;
  background: none;
}
.featured-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
}
.eyebrow {
  margin-bottom: 11px;
  color: #81d4ff;
  font: 700 10px/1.5 var(--lb-font-mono);
  text-transform: uppercase;
  letter-spacing: .16em;
}
.featured h2 {
  max-width: none;
  font-size: clamp(1.7rem, 3.4vw, 2.8rem);
  line-height: 1.05;
  letter-spacing: -.045em;
}
.see-all {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  flex: none;
  min-height: 43px;
  color: #9bdfff;
  font: 700 11px/1.3 var(--lb-font-mono);
  text-decoration: none;
}
.see-all:hover { color: #fff; }
.featured-summary {
  max-width: 65ch;
  margin: 0 0 6px;
  color: #aac3df;
  line-height: 1.5;
  font-size: 13px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: clamp(12px, 1.5vw, 18px);
  margin: 0;
  padding: 0;
  list-style: none;
}
.cards > li { min-width: 0; }
.card {
  --system-color: #65b7ff;
  --system-rgb: 65 183 255;
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  isolation: isolate;
  color: #f3f9ff;
  text-decoration: none;
  border: 1px solid rgb(var(--system-rgb) / 50%);
  border-radius: 12px;
  background:
    radial-gradient(ellipse at 45% 10%, rgb(var(--system-rgb) / 17%), transparent 64%),
    linear-gradient(155deg, #121e34, #090f1d);
  box-shadow: inset 0 0 20px rgb(var(--system-rgb) / 7%), 0 10px 20px rgb(0 0 0 / 12%);
  transition: transform 320ms cubic-bezier(.2,.8,.2,1), border-color 320ms ease, box-shadow 320ms ease;
}
.card--lb-06 { --system-color: #ff797b; --system-rgb: 255 102 112; }
.card--lb-10 { --system-color: #bb8aff; --system-rgb: 169 104 255; }
.card--lb-05 { --system-color: #6df0d1; --system-rgb: 82 224 197; }
.card:hover {
  transform: translateY(-8px);
  border-color: var(--system-color);
  box-shadow: 0 14px 45px rgb(var(--system-rgb) / 23%),
    inset 0 0 30px rgb(var(--system-rgb) / 12%),
    0 0 0 1px rgb(var(--system-rgb) / 22%);
}
.card:focus-visible {
  outline: 3px solid #c1eeff;
  outline-offset: 5px;
}
.card-beam {
  position: absolute;
  pointer-events: none;
  z-index: -1;
  inset: -35%;
  background: conic-gradient(from 100deg at 50% 50%, transparent 0 72%, rgb(var(--system-rgb) / 12%) 80%, transparent 89% 100%);
  animation: beam-spin 19s linear infinite;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 16px 15px 0;
}
.card-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 35px;
  height: 35px;
  font-size: 18px;
  color: var(--system-color);
  border: 1px solid rgb(var(--system-rgb) / 43%);
  border-radius: 9px;
  background: rgb(var(--system-rgb) / 10%);
  box-shadow: 0 0 20px rgb(var(--system-rgb) / 18%);
}
.card-part {
  color: #acc5df;
  font: 600 10px/1.2 var(--lb-font-mono);
}
.demo-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  color: #a6dbc9;
  font: 600 9px/1.2 var(--lb-font-mono);
}
.demo-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #72e7b7;
  box-shadow: 0 0 10px #59cda5;
}
.scene-wrap {
  position: relative;
  display: grid;
  align-items: center;
  min-height: 145px;
  margin: 12px 12px 0;
  overflow: hidden;
  border: 1px solid rgb(var(--system-rgb) / 21%);
  border-radius: 9px;
  background:
    repeating-linear-gradient(0deg, transparent 0 21px, rgb(var(--system-rgb) / 5%) 22px),
    radial-gradient(ellipse at center, rgb(var(--system-rgb) / 17%), transparent 75%), #0a1426;
}
.scene-wrap :deep(.scene) {
  align-self: center;
  width: calc(100% - 18px);
  max-width: none;
  margin: 0 auto;
  border: 0;
  --lb-ink: #caebff;
  --lb-rule: rgb(var(--system-rgb) / 28%);
  --lb-signal: var(--system-color);
}
.card-copy {
  display: grid;
  gap: 10px;
  padding: 19px 16px 14px;
}
.card-copy h3 {
  margin: 0;
  font-size: clamp(1.12rem, 1.65vw, 1.45rem);
  line-height: 1.2;
  letter-spacing: -.03em;
}
.card-copy p {
  display: -webkit-box;
  min-height: 4.7em;
  overflow: hidden;
  color: #b6cae2;
  font-size: 12px;
  line-height: 1.58;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.tag-row { display: flex; flex-wrap: wrap; gap: 5px; }
.tag {
  padding: 4px 6px;
  border: 1px solid rgb(var(--system-rgb) / 27%);
  border-radius: 4px;
  color: #abc4e0;
  background: rgb(var(--system-rgb) / 7%);
  font: 500 9px/1.25 var(--lb-font-mono);
}
.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding: 13px 15px;
  color: #9db8d5;
  border-top: 1px solid rgb(var(--system-rgb) / 21%);
  font: 600 10px/1.3 var(--lb-font-mono);
}
.card-foot strong {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--system-color);
  text-align: right;
  font-size: 10px;
}
.featured-disclaimer {
  margin-top: 0;
  color: #91a9c5;
  font-size: 11px;
  line-height: 1.5;
}
@keyframes beam-spin { to { transform: rotate(360deg); } }
@media (max-width: 1100px) {
  .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 650px) {
  .cards { grid-template-columns: 1fr; }
  .card { min-height: 0; }
  .scene-wrap { min-height: 170px; }
  .card-copy p { min-height: 0; }
  .featured-summary { font-size: 13px; }
}
@media (prefers-reduced-motion: reduce) {
  .card-beam { animation: none; }
  .card { transition: none; }
  .card:hover { transform: none; }
}
</style>
