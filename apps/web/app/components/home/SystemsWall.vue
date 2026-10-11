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
    <p class="kicker">
      {{ t('home.wall.kicker') }}
    </p>
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
</style>
