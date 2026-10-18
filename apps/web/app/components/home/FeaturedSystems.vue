<script setup lang="ts">
// Curated selection drawn entirely from the shared EN/CZ datasheet source.
const { t } = useI18n()
const datasheets = useDatasheets()
const chosen = new Set(['lb-01', 'lb-06', 'lb-10'])
const featured = computed(() => datasheets.value.filter(s => chosen.has(s.slug)))
</script>

<template>
  <section
    id="featured"
    class="featured"
    aria-labelledby="featured-heading"
  >
    <div class="featured-head">
      <div>
        <p class="eyebrow">
          {{ t('home.featured.kicker') }}
        </p>
        <h2 id="featured-heading">
          {{ t('home.featured.title') }}
        </h2>
      </div>
      <p class="summary">
        {{ t('home.featured.intro') }}
      </p>
    </div>
    <ol class="cards">
      <li
        v-for="system in featured"
        :key="system.part"
      >
        <NuxtLinkLocale
          class="card"
          :to="'/systems/' + system.slug"
          :aria-label="t('home.featured.open', { name: system.name })"
        >
          <div class="top">
            <span class="part">{{ system.part }}</span>
            <span class="runtime">{{ system.runtime }}</span>
          </div>
          <div class="scene-wrap">
            <span class="scene-label">{{ t('home.featured.preview') }}</span>
            <HomeTileScene :slug="system.slug" />
          </div>
          <div class="card-content">
            <h3>{{ system.name }}</h3>
            <p>{{ system.function }}</p>
            <div class="details">
              <span>{{ system.tags.slice(0, 2).join(' · ') }}</span>
              <strong>
                {{ t('home.featured.explore') }}
                <span aria-hidden="true">↗</span>
              </strong>
            </div>
          </div>
        </NuxtLinkLocale>
      </li>
    </ol>
    <div class="footer-row">
      <p>{{ t('home.featured.disclaimer') }}</p>
      <NuxtLinkLocale
        class="all"
        :to="{ path: '/', hash: '#systems' }"
      >
        {{ t('home.featured.all') }}
        <span aria-hidden="true">→</span>
      </NuxtLinkLocale>
    </div>
  </section>
</template>

<style scoped>
.featured {
  --lb-ink: #f4f8ff; --lb-graphite: #b1c6de; --lb-sheet: #111d30;
  --lb-rule: rgb(143 190 242 / 23%); --lb-shade: rgb(74 144 235 / 17%); --lb-signal: #83d9ff;
  position: relative; isolation: isolate; display: grid; gap: clamp(24px, 3vw, 40px);
  overflow: hidden; padding: clamp(24px, 4vw, 50px); color: #f4f8ff;
  border: 1px solid rgb(116 166 237 / 30%); border-radius: 20px;
  background: radial-gradient(ellipse at 90% 0%, rgb(35 111 219 / 22%), transparent 55%), #080e19;
}
.featured::before {
  position: absolute; z-index: -1; inset: 0; pointer-events: none; content: '';
  background-image: linear-gradient(rgb(130 174 237 / 4%) 1px,transparent 1px),
    linear-gradient(90deg,rgb(130 174 237 / 4%) 1px,transparent 1px);
  background-size: 44px 44px; mask-image: linear-gradient(to bottom,#000,transparent 85%);
}
.featured-head { display: flex; justify-content: space-between; align-items: end; gap: 24px; }
.eyebrow,.part,.runtime,.scene-label,.details,.all { font-family: var(--lb-font-mono); font-size: 11px; }
.eyebrow { margin: 0 0 14px; color: #91dcff; letter-spacing: .12em; text-transform: uppercase; }
h2 { max-width: 16ch; margin: 0; font-size: clamp(2rem,4vw,3.4rem); letter-spacing: -.045em; line-height: 1.02; }
.summary { max-width: 35ch; margin: 0; color: #b9cce3; line-height: 1.6; font-size: 15px; }
.cards { display: grid; grid-template-columns: minmax(0,1.35fr) minmax(0,1fr);
  gap: 14px; padding: 0; margin: 0; list-style: none; }
.cards li:first-child { grid-row: span 2; }
.card { display: flex; flex-direction: column; height: 100%; min-height: 235px;
  overflow: hidden; color: #f4f8ff; text-decoration: none; border-radius: 14px;
  border: 1px solid rgb(142 182 237 / 25%); background: linear-gradient(140deg,#182740,#101a2b);
  transition: border-color 230ms ease, transform 230ms ease, box-shadow 230ms ease; }
.card:hover { transform: translateY(-4px); border-color: #91dcff; box-shadow: 0 18px 40px rgb(22 101 229 / 19%); }
.card:focus-visible,.all:focus-visible { outline: 2px solid #d1efff; outline-offset: 4px; }
.top { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px;
  padding: 15px 18px; border-bottom: 1px solid rgb(145 183 231 / 18%); }
.part { color: #92dfff; font-weight: 700; } .runtime { color: #b0c2db; }
.scene-wrap { position: relative; display: grid; flex: 1; align-content: center; min-height: 124px;
  padding: 16px 12px 8px; background: radial-gradient(ellipse at 50% 120%,rgb(38 118 242 / 26%),transparent 72%),#101c2f; }
.cards li:first-child .scene-wrap { min-height: 220px; }
.scene-label { position: absolute; top: 12px; left: 18px; color: #b4cce7; }
.scene-wrap :deep(.scene) { width: min(100%,440px); margin: 8px auto 0; border-color: rgb(155 190 234 / 16%); }
.card-content { display: grid; gap: 10px; padding: 18px; }
h3 { margin: 0; font-size: clamp(1.25rem,2.1vw,1.65rem); letter-spacing: -.025em; }
.card-content > p { max-width: 55ch; margin: 0; color: #bccfe4; line-height: 1.55; font-size: 14px; }
.details { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 10px; margin-top: 9px; padding-top: 14px; color: #b4c8de;
  border-top: 1px solid rgb(145 183 231 / 20%); }
.details strong { color: #9adfff; font-size: 12px; white-space: nowrap; }
.footer-row { display: flex; justify-content: space-between; align-items: center; gap: 20px; }
.footer-row p { max-width: 62ch; margin: 0; color: #b3c9df; font-size: 12px; line-height: 1.5; }
.all { display: inline-flex; min-height: 44px; flex: none; align-items: center; gap: 10px;
  color: #bfe9ff; font-weight: 700; text-decoration: none; }
.all:hover { color: #fff; }
@media (max-width: 800px) {
  .featured-head { display: grid; }
  .cards { grid-template-columns: minmax(0,1fr); }
  .cards li:first-child { grid-row: auto; }
  .cards li:first-child .scene-wrap { min-height: 145px; }
}
@media (max-width: 520px) {
  .featured { padding: 20px 16px; border-radius: 14px; }
  .footer-row { flex-direction: column; align-items: start; }
}
@media (prefers-reduced-motion: reduce) {
  .card { transition: none; }
  .card:hover { transform: none; }
}
</style>
