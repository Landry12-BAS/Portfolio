<script setup lang="ts">
// The app shell: the layout around the current page. The head every page shares (the
// language, the favicon, the description) is set in layouts/default.vue, which error
// pages use too.
</script>

<template>
  <NuxtLayout>
    <!-- Pages change with a short fade and a four-pixel rise (the page classes in packages/ui, base.css),
         the old one leaving before the new one comes, so nothing overlaps or flashes. -->
    <NuxtPage :transition="{ name: 'page', mode: 'out-in' }" />
  </NuxtLayout>
</template>
