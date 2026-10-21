<script setup lang="ts">
// The home page: the first screen (the headline beside the Scope playing a recorded run), the wall of
// the ten systems at work, then the selection guide (section 1), what every system page shows
// (section 2), and the build order (section 3).
const { t } = useI18n()
const datasheets = useDatasheets()
const locale = useLocaleCode()
const canonicalUrl = computed(() => locale.value === 'cs' ? 'https://landrybodjona.com/cs' : 'https://landrybodjona.com/')

useSeoMeta({
  title: () => t('home.title'),
  description: () => t('site.description'),
  ogType: 'website',
  ogSiteName: 'Tchiwa Kibolou Bodjona',
  ogTitle: () => `${t('home.title')} · Tchiwa Kibolou Bodjona`,
  ogDescription: () => t('site.description'),
  ogUrl: () => canonicalUrl.value,
  twitterCard: 'summary',
})
// Canonical URLs are compatible with the strict Trusted Types security policy.
// Structured data will be introduced with a server-only HTML solution.
useHead(() => ({
  link: [{ rel: 'canonical', href: canonicalUrl.value }],
}))

// What is below the fold comes in as the visitor reaches it: the tiles of the wall, then each section.
useRevealOnScroll(['#activity', '#featured .cards > li', '.tiles > li', '#scope', '.proof-unit', '#systems', '#anatomy', '#build', '#about', '#contact'])

// The three build phases, with their names and descriptions in this language.
const phases = computed(() => [
  { phase: 1 as const, title: t('home.build.foundation'), text: t('home.build.foundationText') },
  { phase: 2 as const, title: t('home.build.breadth'), text: t('home.build.breadthText') },
  { phase: 3 as const, title: t('home.build.showpieces'), text: t('home.build.showpiecesText') },
])

/** Returns the systems built in a phase, in catalog order. */
function inPhase(phase: 1 | 2 | 3) {
  return datasheets.value.filter(system => system.phase === phase)
}
</script>

<template>
  <div class="home">
    <HomeHeroScope />

    <HomeActivityStrip />

    <HomeFeaturedSystems />

    <HomeSystemsWall />

    <HomeTraceConsole />

    <section class="proof-strip" :aria-label="t('home.proof.label')">
      <div class="proof-unit">
        <strong>{{ datasheets.length }}</strong>
        <span>{{ t('home.proof.systems') }}</span>
      </div>
      <div class="proof-unit">
        <strong>3</strong>
        <span>{{ t('home.proof.backends') }}</span>
      </div>
      <div class="proof-unit">
        <strong>EN / CZ</strong>
        <span>{{ t('home.proof.languages') }}</span>
      </div>
      <div class="proof-unit">
        <strong>↗</strong>
        <span>{{ t('home.proof.traces') }}</span>
      </div>
    </section>

    <section id="systems">
      <LbSectionHead
        num="1"
        :title="t('home.guide.title')"
      />
      <p class="sec-intro">
        {{ t('home.guide.intro') }}
      </p>
      <CatalogGuide />
    </section>

    <section id="anatomy">
      <LbSectionHead
        num="2"
        :title="t('home.anatomy.title')"
      />
      <dl class="points">
        <div>
          <dt>{{ t('home.anatomy.datasheet') }}</dt>
          <dd>{{ t('home.anatomy.datasheetText') }}</dd>
        </div>
        <div>
          <dt>{{ t('home.anatomy.board') }}</dt>
          <dd>{{ t('home.anatomy.boardText') }}</dd>
        </div>
        <div>
          <dt>{{ t('home.anatomy.scope') }}</dt>
          <dd>{{ t('home.anatomy.scopeText') }}</dd>
        </div>
      </dl>
    </section>

    <section id="build">
      <LbSectionHead
        num="3"
        :title="t('home.build.title')"
      />
      <ol class="phases">
        <li
          v-for="item in phases"
          :key="item.phase"
        >
          <div class="ph-top">
            <!-- The three phases are the order the systems were built in, and all three are done. -->
            <LbPill variant="solid">
              {{ t('home.build.phase', { n: item.phase }) }}
            </LbPill>
            <h3>{{ item.title }}</h3>
          </div>
          <ul class="ph-list">
            <li v-if="item.phase === 1">
              <span class="ph-part">LB-00</span>{{ t('home.build.platform') }}
            </li>
            <li
              v-for="system in inPhase(item.phase)"
              :key="system.part"
            >
              <NuxtLinkLocale
                class="ph-part"
                :to="`/systems/${system.slug}`"
              >
                {{ system.part }}
              </NuxtLinkLocale>{{ system.name }}
            </li>
          </ul>
          <p>{{ item.text }}</p>
        </li>
      </ol>
    </section>

    <section id="about" class="about-panel">
      <div>
        <p class="section-eyebrow">
          {{ t('home.career.aboutLabel') }}
        </p>
        <h2>{{ t('home.career.aboutTitle') }}</h2>
      </div>
      <div class="about-copy">
        <p>{{ t('home.career.aboutBody') }}</p>
        <a href="https://github.com/Landry12-BAS" target="_blank" rel="noopener noreferrer">
          {{ t('home.career.github') }} <span aria-hidden="true">↗</span>
        </a>
      </div>
    </section>

    <section id="contact" class="contact-panel">
      <div>
        <p class="section-eyebrow">
          {{ t('home.career.contactLabel') }}
        </p>
        <h2>{{ t('home.career.contactTitle') }}</h2>
        <p>{{ t('home.career.contactBody') }}</p>
      </div>
      <a class="contact-button" href="https://github.com/Landry12-BAS" target="_blank" rel="noopener noreferrer">
        {{ t('home.career.contactAction') }} <span aria-hidden="true">↗</span>
      </a>
    </section>
  </div>
</template>

<style scoped>
.home {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: clamp(44px, 6vw, 76px);
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
  .points,
  .phases {
    grid-template-columns: minmax(0, 1fr);
  }
}

.home { gap: clamp(38px, 5.4vw, 75px); }
.home > section { scroll-margin-top: 92px; }
.proof-strip { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 0;
  margin-top: -40px; overflow: hidden; border: 1px solid #274369; border-radius: 12px;
  background: linear-gradient(105deg,#12243b,#0a1627); }
.proof-unit { display: grid; gap: 7px; padding: 24px 28px; border-right: 1px solid #2a4161; }
.proof-unit:last-child { border-right: none; }
.proof-unit strong { color: #d3eeff; font-size: clamp(1.3rem,2.1vw,2rem); line-height: 1.2; }
.proof-unit span { color: #a8c1df; font: 11px/1.45 var(--lb-font-mono); letter-spacing: .035em; }
#systems, #anatomy, #build { border-top: 1px solid #294362; padding-top: 30px; }
#systems :deep(.lb-section-head),#anatomy :deep(.lb-section-head),#build :deep(.lb-section-head) {
  margin-bottom: 16px;
}
.sec-intro { color: #b6c8df; font-size: 15px; line-height: 1.7; }
.points { gap: 14px; }
.points > div { padding: 26px; border: 1px solid #273b57; border-radius: 12px;
  background: linear-gradient(160deg,#101e33,#0c1524); }
.points dt { font-size: 1.1rem; color: #eaf6ff; }
.points dd { margin-top: 12px; color: #b4c7de; line-height: 1.65; }
.phases { gap: 14px; }
.phases > li { padding: 26px; gap: 18px; border: 1px solid #294260; border-radius: 12px;
  background: linear-gradient(160deg,#13263d,#0c1728); }
.phases h3 { color: #fff; } .phases p { color: #afc4e2; }
.ph-list { gap: 9px; } .ph-list a { color: #95dbff; }
.section-eyebrow { color: #87d1ff; font: 700 11px var(--lb-font-mono); letter-spacing: .13em; text-transform: uppercase; }
.about-panel { display: grid; grid-template-columns: 1fr 1fr; align-items: start; gap: 48px; padding: 42px;
  border: 1px solid #274466; border-radius: 15px; background: linear-gradient(125deg,#101f33,#0a1322); }
.about-panel h2,.contact-panel h2 { max-width: 17ch; margin-top: 18px;
  font-size: clamp(2rem,4vw,3.8rem); letter-spacing: -.045em; line-height: 1.08; }
.about-copy { display: grid; gap: 26px; padding-top: 22px; color: #c5d6e9; font-size: 16px; line-height: 1.7; }
.about-copy a { color: #8edcff; font-weight: 700; }
.contact-panel { display: flex; align-items: center; justify-content: space-between; gap: 30px;
  padding: clamp(28px,5vw,55px); border: 1px solid #38639a; border-radius: 16px;
  background: radial-gradient(ellipse at 88% 19%,#216ac442,transparent 60%),linear-gradient(130deg,#172c48,#0d1829); }
.contact-panel p:not(.section-eyebrow) { max-width: 58ch; margin-top: 16px; color: #c1d2e7; }
.contact-button { display: inline-flex; align-items: center; gap: 18px; flex: none;
  min-height: 53px; padding: 0 25px; border-radius: 7px; color: #061626; background: #97ddff;
  font-size: 14px; font-weight: 800; text-decoration: none; box-shadow: 0 0 28px #358cff4a;
  transition: transform 220ms ease,box-shadow 220ms ease; }
.contact-button:hover { transform: translateY(-3px); box-shadow: 0 0 37px #358cff90; }
@media (max-width: 800px) {
  .proof-strip { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .proof-unit:nth-child(2) { border-right: 0; }
  .proof-unit:nth-child(-n+2) { border-bottom: 1px solid #2a4161; }
  .about-panel { grid-template-columns: 1fr; gap: 4px; padding: 28px; }
}
@media (max-width: 580px) {
  .proof-unit { padding: 20px 15px; }
  .contact-panel { flex-direction: column; align-items: start; }
  .contact-button { width: 100%; justify-content: center; }
}
@media (prefers-reduced-motion: reduce) { .contact-button { transition: none; } .contact-button:hover { transform: none; } }

/* More precise cinematic page rhythm, matching the approved editorial mockup. */
.home { gap: clamp(30px, 4.3vw, 56px); }
.home :deep(.activity) { margin-top: -11px; }
.home :deep(.trace-stage) { margin-top: 5px; }
.proof-strip {
  margin-top: -10px;
  border-color: rgb(95 164 250 / 36%);
  background:
    radial-gradient(ellipse at 35% 0%, rgb(21 102 212 / 17%), transparent 70%),
    linear-gradient(110deg,#0d1b31,#081221);
}
.proof-unit { padding: 26px 23px; }
.proof-unit strong {
  color: #e2f4ff;
  text-shadow: 0 0 24px rgb(38 154 255 / 30%);
}
.home > section { min-width: 0; }
@media (max-width: 640px) {
  .home { gap: 33px; }
  .proof-strip { margin-top: 0; }
}
:global(html.light) .home .sec-intro { color: #3b5875; }
:global(html.light) .home .section-eyebrow { color: #0a669c; }
:global(html.light) .home :deep(.wall-head h2) { color: #0c243e; }
</style>
