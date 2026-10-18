<script setup lang="ts">
// The home page: the first screen (the headline beside the Scope playing a recorded run), the wall of
// the ten systems at work, then the selection guide (section 1), what every system page shows
// (section 2), and the build order (section 3).
const { t } = useI18n()
const datasheets = useDatasheets()

useSeoMeta({ title: () => t('home.title') })

// What is below the fold comes in as the visitor reaches it: the tiles of the wall, then each section.
useRevealOnScroll(['#featured', '.tiles > li', '#systems', '#anatomy', '#build'])

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

    <HomeFeaturedSystems />

    <HomeSystemsWall />

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
</style>
