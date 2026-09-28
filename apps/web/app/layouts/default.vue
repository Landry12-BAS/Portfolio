<template>
  <div class="site">
    <a
      class="skip"
      href="#main"
    >Skip to content</a>
    <SiteToolbar />
    <main
      id="main"
      class="sheet"
      tabindex="-1"
    >
      <slot />
    </main>
    <SiteFooter />
  </div>
</template>

<style scoped>
.site {
  padding-inline: var(--lb-gutter);
  padding-block: 0 56px;
}

.skip {
  position: absolute;
  left: 12px;
  top: -60px;
  z-index: 40;
  padding: 10px 14px;
  font-weight: 700;
  color: var(--lb-sheet);
  background: var(--lb-ink);
  border-radius: 4px;
}

.skip:focus {
  top: 12px;
}

.sheet {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: clamp(44px, 6vw, 76px);
  max-width: 1180px;
  margin: 24px auto 0;
  padding: clamp(18px, 4.5vw, 56px);
  background: var(--lb-sheet);
  border: 1px solid var(--lb-rule);
}

.sheet:focus {
  outline: none;
}

@media (max-width: 640px) {
  .sheet {
    margin-top: 16px;
    padding: 20px 14px;
  }
}
</style>
