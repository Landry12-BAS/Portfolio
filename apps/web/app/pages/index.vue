<script setup lang="ts">
// The home page: the masthead with a quick reference, the selection guide (section 1),
// what every system page shows (section 2), and the build order (section 3).
const { t } = useI18n()
const datasheets = useDatasheets()

useSeoMeta({ title: () => t('home.title') })

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
    <header class="masthead">
      <div class="intro">
        <p class="kicker">
          {{ t('home.kicker') }}
        </p>
        <h1>{{ t('home.heading') }}</h1>
        <p class="lede">
          {{ t('home.lede') }}
        </p>
      </div>
      <aside
        class="quickref"
        :aria-label="t('home.quickref.label')"
      >
        <span class="stamp">{{ t('home.quickref.stamp') }}</span>
        <dl>
          <dt>{{ t('home.quickref.owner') }}</dt>
          <dd>Landry Bodjona</dd>
          <dt>{{ t('home.quickref.systems') }}</dt>
          <dd>{{ t('home.quickref.systemsValue') }}</dd>
          <dt>{{ t('home.quickref.backends') }}</dt>
          <dd>{{ t('home.quickref.backendsValue') }}</dd>
          <dt>{{ t('home.quickref.frontend') }}</dt>
          <dd>{{ t('home.quickref.frontendValue') }}</dd>
          <dt>{{ t('home.quickref.ai') }}</dt>
          <dd>{{ t('home.quickref.aiValue') }}</dd>
          <dt>{{ t('home.quickref.languages') }}</dt>
          <dd>{{ t('home.quickref.languagesValue') }}</dd>
          <dt>{{ t('home.quickref.accounts') }}</dt>
          <dd>{{ t('home.quickref.accountsValue') }}</dd>
        </dl>
      </aside>
    </header>

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
          :class="{ later: item.phase === 3 }"
        >
          <div class="ph-top">
            <LbPill :variant="item.phase === 1 ? 'solid' : item.phase === 3 ? 'dashed' : 'outline'">
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
