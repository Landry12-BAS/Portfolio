<script setup lang="ts">
const { t } = useI18n()
const datasheets = useDatasheets()
const ids = ['lb-01', 'lb-06', 'lb-10', 'lb-05']
const selected = computed(() => ids.flatMap(slug => datasheets.value.filter(system => system.slug === slug)))
</script>

<template>
  <section
    id="activity"
    class="activity"
    :aria-label="t('home.featured.kicker')"
  >
    <div class="activity-heading">
      <span class="activity-light" aria-hidden="true" />
      <span>{{ t('home.featured.kicker') }}</span>
      <NuxtLinkLocale to="/systems/lb-01" class="activity-more">
        {{ t('home.hero.scope.title') }}
        <span aria-hidden="true">↗</span>
      </NuxtLinkLocale>
    </div>
    <ul class="activity-list">
      <li
        v-for="(system, i) in selected"
        :key="system.slug"
      >
        <NuxtLinkLocale :to="`/systems/${system.slug}`" class="activity-link">
          <span class="activity-number">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="activity-copy">
            <strong>{{ system.name }}</strong>
            <small>{{ system.runtime }}</small>
          </span>
          <span class="activity-wave" aria-hidden="true">
            <i /><i /><i /><i /><i /><i /><i /><i />
          </span>
          <span class="activity-arrow" aria-hidden="true">↗</span>
        </NuxtLinkLocale>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.activity {
  --activity-text: #f3f8ff;
  display: grid;
  gap: 0;
  overflow: hidden;
  color: var(--activity-text);
  border: 1px solid rgb(108 165 234 / 38%);
  border-radius: 13px;
  background: linear-gradient(120deg, #0d1a2e, #081121);
  box-shadow: inset 0 1px rgb(158 203 255 / 13%);
}
.activity-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 10px 17px;
  color: #a4c8eb;
  font: 700 10px/1.3 var(--lb-font-mono);
  text-transform: uppercase;
  letter-spacing: .09em;
  border-bottom: 1px solid rgb(111 159 217 / 27%);
}
.activity-light {
  flex: none;
  width: 7px;
  height: 7px;
  background: #69e6c1;
  border-radius: 50%;
  box-shadow: 0 0 13px #69e6c1;
  animation: activity-pulse 2.5s ease-in-out infinite;
}
.activity-more {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 25px;
  margin-left: auto;
  text-decoration: none;
  color: #96dfff;
  font: 600 10px/1.4 var(--lb-font-mono);
}
.activity-list {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  padding: 0;
  margin: 0;
  list-style: none;
}
.activity-list li:not(:last-child) {
  border-right: 1px solid rgb(110 165 229 / 26%);
}
.activity-link {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 91px;
  gap: 10px;
  padding: 14px 13px;
  color: #edf8ff;
  text-decoration: none;
  transition: background 220ms ease;
}
.activity-link:hover,
.activity-link:focus-visible {
  background: rgb(49 134 245 / 15%);
}
.activity-number {
  display: grid;
  flex: none;
  place-items: center;
  width: 33px;
  height: 33px;
  color: #8bdaff;
  font: 700 10px var(--lb-font-mono);
  border-radius: 9px;
  border: 1px solid rgb(97 177 248 / 48%);
  background: rgb(15 88 182 / 14%);
}
.activity-copy {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.activity-copy strong {
  color: #f7faff;
  font-size: 13px;
  line-height: 1.25;
}
.activity-copy small {
  color: #aac1dc;
  font-size: 10px;
  line-height: 1.35;
}
.activity-wave {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
  height: 21px;
  margin-left: auto;
}
.activity-wave i {
  display: block;
  width: 2px;
  height: 20%;
  background: #66cbff;
  border-radius: 2px;
  transform-origin: center;
  animation: bars 1.6s ease-in-out infinite alternate;
}
.activity-wave i:nth-child(2n) { animation-delay: -550ms; }
.activity-wave i:nth-child(3n) { animation-delay: -900ms; }
.activity-wave i:nth-child(4n) { animation-delay: -200ms; }
.activity-arrow { color: #90cfff; }
@keyframes bars { 35% { height: 85%; } 75% { height: 45%; } }
@keyframes activity-pulse { 55% { opacity: .4; } }
@media (max-width: 1090px) {
  .activity-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .activity-list li:nth-child(2) { border-right: 0; }
  .activity-list li:nth-child(-n+2) { border-bottom: 1px solid rgb(110 165 229 / 26%); }
}
@media (max-width: 530px) {
  .activity-list { grid-template-columns: 1fr; }
  .activity-list li { border-right: 0 !important; }
  .activity-list li:not(:last-child) { border-bottom: 1px solid rgb(110 165 229 / 26%); }
  .activity-link { min-height: 68px; }
  .activity-heading { font-size: 9px; }
  .activity-more { font-size: 9px; }
}
@media (prefers-reduced-motion: reduce) {
  .activity-wave i,
  .activity-light { animation: none; }
  .activity-link { transition: none; }
}
</style>
