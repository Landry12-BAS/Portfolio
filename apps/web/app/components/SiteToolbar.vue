<script setup lang="ts">
type Preference = 'light' | 'dark' | 'system'

const colorMode = useColorMode()

const preference = computed<Preference>({
  get: () => (['light', 'dark'].includes(colorMode.preference) ? colorMode.preference : 'system') as Preference,
  set: (value) => {
    colorMode.preference = value
  },
})
</script>

<template>
  <header class="toolbar">
    <NuxtLink
      to="/"
      class="brand"
    >
      <LbLogo
        :height="20"
        label=""
      />
      <span class="wordmark">Landry Bodjona</span>
    </NuxtLink>
    <nav
      class="nav"
      aria-label="Sections"
    >
      <NuxtLink to="/#systems">
        Systems
      </NuxtLink>
      <NuxtLink to="/#build">
        Build order
      </NuxtLink>
    </nav>
    <!-- The saved theme is only known in the browser, so the toggle renders there;
         the slot keeps its width so nothing shifts when it appears. -->
    <ClientOnly>
      <LbThemeToggle v-model="preference" />
      <template #fallback>
        <span
          class="toggle-slot"
          aria-hidden="true"
        />
      </template>
    </ClientOnly>
  </header>
</template>

<style scoped>
.toolbar {
  position: sticky;
  top: env(safe-area-inset-top, 0px);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 18px;
  margin-inline: calc(var(--lb-gutter) * -1);
  padding: 10px var(--lb-gutter);
  background: var(--lb-desk);
  border-bottom: 1px solid var(--lb-rule);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--lb-ink);
  text-decoration: none;
}

.wordmark {
  font-size: 13px;
  font-weight: 800;
  font-stretch: 125%;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  white-space: nowrap;
}

.nav {
  display: flex;
  gap: 16px;
  margin-left: auto;
}

.nav a {
  padding-block: 2px;
  font-size: 13px;
  color: var(--lb-ink);
  text-decoration: none;
  border-bottom: 1px solid transparent;
}

.nav a:hover {
  border-bottom-color: var(--lb-ink);
}

.toggle-slot {
  display: inline-block;
  width: 128px;
  height: 35px;
}

@media (max-width: 640px) {
  .nav {
    display: none;
  }

  .toolbar > :last-child {
    margin-left: auto;
  }

  .wordmark {
    font-size: 12px;
  }
}
</style>
