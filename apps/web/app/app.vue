<script setup lang="ts">
import favicon from '#brand/lb-favicon.svg?url'

useHead({
  link: [{ rel: 'icon', type: 'image/svg+xml', href: favicon }],
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
