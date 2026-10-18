<script setup lang="ts">
// <HomeSystemsWall>: the first sight of the ten systems, as a wall of tiles. Each tile is one system at
// work, drawn small (HomeTileScene), with its part number, back end, name and what a visitor does there,
// and it opens the system's datasheet. The scenes are decoration: the words on each tile say it all.
const { t } = useI18n()
const datasheets = useDatasheets()
</script>

<template>
  <section
    class="wall"
    :aria-label="t('home.wall.label')"
  >
    <div class="wall-head">
      <div>
        <p class="kicker">{{ t('home.wall.kicker') }}</p>
        <h2>{{ t('home.wall.title') }}</h2>
      </div>
      <span class="wall-count">{{ datasheets.length }} / {{ t('home.wall.count') }}</span>
    </div>
    <ul class="tiles">
      <li
        v-for="system in datasheets"
        :key="system.part"
      >
        <NuxtLinkLocale
          class="tile"
          :class="{ 'tile--lit': system.slug === 'lb-01' }"
          :to="`/systems/${system.slug}`"
          :aria-label="t('home.wall.open', { part: system.part, name: system.name })"
        >
          <span class="tile-head">
            <span class="part">{{ system.part }}</span>
            <span class="runtime">{{ system.runtime }}</span>
          </span>
          <HomeTileScene :slug="system.slug" />
          <span class="tile-foot">
            <span class="name">{{ system.name }}</span>
            <span class="action">{{ system.visitorAction }}</span>
            <span class="tile-cta">{{ t('home.featured.explore') }} <span aria-hidden="true">↗</span></span>
          </span>
        </NuxtLinkLocale>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.wall {
  display: grid;
  gap: 12px;
}

.kicker {
  font-family: var(--lb-font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--lb-graphite);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.tile {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 236px;
  color: var(--lb-ink);
  text-decoration: none;
  background: var(--lb-sheet);
  border: 1.5px solid var(--lb-rule);
  transition: border-color var(--lb-motion-fast) var(--lb-ease), transform var(--lb-motion-fast) var(--lb-ease);
}

.tile:hover {
  border-color: var(--lb-ink);
  transform: translateY(-2px);
}

.tile--lit {
  border-color: var(--lb-signal);
}

.tile-head,
.tile-foot {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px 8px;
}

.tile-head {
  flex-direction: row;
  justify-content: space-between;
  font-family: var(--lb-font-mono);
  font-size: 11px;
}

.part {
  flex: none;
  font-weight: 700;
  white-space: nowrap;
}

.tile--lit .part {
  color: var(--lb-signal);
}

.runtime {
  min-width: 0;
  overflow: hidden;
  color: var(--lb-graphite);
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-foot {
  padding: 8px 12px 10px;
}

.name {
  font-size: 14px;
  font-weight: 700;
  font-stretch: 112%;
}

.action {
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--lb-graphite);
}

@media (prefers-reduced-motion: reduce) {
  .tile {
    transition: none;
  }

  .tile:hover {
    transform: none;
  }
}

@media (max-width: 1100px) {
  .tiles {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .tile {
    min-height: 0;
  }

  .action {
    display: none;
  }
}

.wall { gap: 28px; }
.wall-head { display: flex; align-items: end; justify-content: space-between; gap: 18px; }
.wall-head h2 { margin-top: 14px; font-size: clamp(2rem, 4vw, 3.7rem); letter-spacing: -.055em; line-height: 1.05; }
.wall-count { flex: none; font: 11px var(--lb-font-mono); color: #89cdfa; }
.wall .tiles { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 13px; }
.wall .tile { min-height: 290px; border: 1px solid rgb(122 168 223 / 23%); border-radius: 11px;
  overflow: hidden; background: linear-gradient(150deg,#14233a,#0b1423); color: #eef6ff;
  transition: transform 250ms var(--lb-ease), border-color 250ms, box-shadow 250ms; }
.wall .tile:hover { border-color: #73ccff; transform: translateY(-5px);
  box-shadow: 0 18px 34px rgb(7 89 215 / 21%), 0 0 24px rgb(55 139 236 / 12%); }
.wall .tile:focus-visible { outline: 2px solid #a4e6ff; outline-offset: 3px; }
.wall .tile--lit { border-color: rgb(119 208 255 / 55%); box-shadow: inset 0 0 24px rgb(59 136 245 / 8%); }
.wall .tile-head { color: #afc6e3; padding: 13px 15px 9px; }
.wall .tile .part { color: #80cfff; }
.wall .tile .runtime { color: #a6bfdf; }
.wall .tile :deep(.scene) { border-color: rgb(151 189 234 / 16%); }
.wall .tile-foot { flex: 1; gap: 8px; padding: 13px 15px 16px; }
.wall .name { color: #f4f8ff; font-size: 15px; }
.wall .action { display: block; color: #adc4df; font-size: 12px; line-height: 1.5; }
.wall .tile-cta { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: auto; padding-top: 10px; color: #8edbff; border-top: 1px solid rgb(140 185 231 / 16%);
  font: 700 11px var(--lb-font-mono); }
@media (max-width: 1099px) { .wall .tiles { grid-template-columns: repeat(3,minmax(0,1fr)); } }
@media (max-width: 700px) { .wall .tiles { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media (max-width: 420px) { .wall .tiles { grid-template-columns: minmax(0,1fr); } .wall .tile { min-height: 260px; } }
@media (prefers-reduced-motion: reduce) { .wall .tile { transition: none; } .wall .tile:hover { transform: none; } }
</style>
