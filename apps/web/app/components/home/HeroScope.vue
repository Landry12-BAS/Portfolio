<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <section
    class="hero"
    :aria-label="t('home.hero.label')"
  >
    <div class="hero-grid">
      <div class="intro">
        <p class="kicker">
          {{ t('home.kicker') }}
        </p>
        <p class="role">
          {{ t('home.hero.role') }}
        </p>
        <h1>{{ t('home.heading') }}</h1>
        <p class="lede">
          {{ t('home.lede') }}
        </p>
        <div class="ways">
          <NuxtLinkLocale
            class="way way--solid"
            :to="{ path: '/', hash: '#featured' }"
          >
            {{ t('home.hero.pick') }}
            <span aria-hidden="true">↗</span>
          </NuxtLinkLocale>
          <NuxtLinkLocale
            class="way"
            :to="{ path: '/', hash: '#scope' }"
          >
            {{ t('home.hero.trace') }}
            <span aria-hidden="true">⌁</span>
          </NuxtLinkLocale>
        </div>
        <div class="skills" :aria-label="t('home.quickref.backends')">
          <span>Python</span>
          <span>Django</span>
          <span>Flask</span>
          <span>Node.js</span>
          <span>TypeScript</span>
          <span>Nuxt / Vue</span>
        </div>
        <p class="facts">
          <span class="stamp">{{ t('home.quickref.stamp') }}</span>
          <span>{{ t('home.hero.facts') }}</span>
        </p>
      </div>
      <HomeCinematicVisual />
    </div>
  </section>
</template>

<style scoped>
.hero {
  position: relative;
  overflow: hidden;
  isolation: isolate;
  min-height: 620px;
  color: #f5faff;
  border: 1px solid rgb(96 161 246 / 42%);
  border-radius: 15px;
  background:
    radial-gradient(ellipse at 73% 30%, rgb(16 116 251 / 15%), transparent 53%),
    radial-gradient(ellipse at 12% 82%, rgb(0 94 222 / 14%), transparent 53%),
    #050d1c;
  box-shadow: 0 0 0 1px rgb(95 165 242 / 7%), 0 20px 80px rgb(0 0 0 / 17%);
}
.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image:
    linear-gradient(rgb(128 184 255 / 4%) 1px, transparent 1px),
    linear-gradient(90deg, rgb(128 184 255 / 4%) 1px, transparent 1px);
  background-size: 65px 65px;
  mask-image: linear-gradient(to bottom, #000 0%, transparent 95%);
}
.hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  align-items: center;
  gap: clamp(12px, 2vw, 32px);
  padding: clamp(36px, 5vw, 72px);
}
.intro {
  display: grid;
  position: relative;
  z-index: 2;
  align-content: center;
  justify-items: start;
  gap: clamp(12px, 1.8vw, 20px);
}
.kicker,
.role {
  font-family: var(--lb-font-mono);
  text-transform: uppercase;
  letter-spacing: .11em;
  font-size: 11px;
}
.kicker { color: #8edbff; }
.role { color: #9db8d9; font-size: 10px; }
h1 {
  max-width: 13ch;
  font-size: clamp(3.15rem, 5.1vw, 5.95rem);
  font-weight: 850;
  line-height: .99;
  letter-spacing: -.058em;
  text-wrap: balance;
}
.lede {
  max-width: 52ch;
  color: #c0d2e9;
  font-size: clamp(14px, 1.4vw, 17px);
  line-height: 1.65;
}
.ways {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 7px;
}
.way {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  min-height: 48px;
  padding: 10px 18px;
  color: #e6f3ff;
  font-size: 13px;
  font-weight: 800;
  text-decoration: none;
  border: 1px solid #547ba6;
  border-radius: 7px;
  background: rgb(8 23 43 / 45%);
  transition: transform 240ms ease, background 240ms ease, box-shadow 240ms ease;
}
.way:hover { transform: translateY(-3px); border-color: #b2e8ff; background: #132c4d; }
.way--solid {
  border-color: #8cdbff;
  background: linear-gradient(135deg,#71c9ff,#b6eeff);
  color: #031424;
  box-shadow: 0 0 28px rgb(31 153 255 / 32%);
}
.way--solid:hover { background: #d1f4ff; box-shadow: 0 0 43px rgb(31 153 255 / 58%); }
.way:focus-visible { outline: 2px solid #d4f7ff; outline-offset: 4px; }
.skills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 5px; }
.skills span {
  padding: 5px 9px;
  font: 600 10px/1.35 var(--lb-font-mono);
  border-radius: 4px;
  color: #cbe7ff;
  border: 1px solid rgb(120 174 241 / 29%);
  background: rgb(18 45 80 / 49%);
}
.facts { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; color: #9bbbdc;
  font: 500 10px/1.6 var(--lb-font-mono); }
.stamp { padding: 5px 9px; color: #dbf2ff; border: 1px solid rgb(124 185 253 / 48%); border-radius: 4px; }
@media (max-width: 1050px) {
  .hero-grid { grid-template-columns: 1fr; padding: clamp(22px, 4vw, 44px); }
  .intro { max-width: 680px; }
  h1 { font-size: clamp(3rem, 7vw, 5rem); }
}
@media (max-width: 600px) {
  .hero { min-height: 0; }
  .hero-grid { padding: 27px 20px 14px; }
  h1 { font-size: clamp(2.55rem, 10.2vw, 4rem); }
  .way { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .way { transition: none; }
  .way:hover { transform: none; }
}
</style>
