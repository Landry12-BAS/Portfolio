<script setup lang="ts">
// <AudioPlayer>: the browser's own audio player over the meeting's audio: a curated sample's file
// served by the site, or the visitor's recording held in the browser as an object URL. It never
// fetches anything from the back end (the back end deletes the audio once transcribed, so there is
// nothing to fetch). The transcript and the items ask it to jump to a second and play, and it tells
// the board the second it is at, so the segment being heard can be shown.
import { ref } from 'vue'

const props = defineProps<{
  /** The address of the audio, or undefined before there is any. */
  src: string | undefined
  /** Names the player for assistive tech. */
  label: string
}>()

const emit = defineEmits<{ time: [seconds: number] }>()

const element = ref<HTMLAudioElement>()

/** Jumps to a second of the audio, and plays from there when asked. A browser may refuse to play; that is not an error worth showing. */
function seekTo(seconds: number, play: boolean): void {
  const audio = element.value
  if (!audio) return
  audio.currentTime = Math.max(seconds, 0)
  emit('time', audio.currentTime)
  if (!play || typeof audio.play !== 'function') return
  try {
    const playing = audio.play()
    if (playing && typeof playing.catch === 'function') playing.catch(() => undefined)
  }
  catch {
    // A browser that will not play without a gesture, or has no sound output.
  }
}

/** Says where the playback is. */
function tell(): void {
  const audio = element.value
  if (audio) emit('time', audio.currentTime)
}

defineExpose({ seekTo })
</script>

<template>
  <div class="player">
    <!-- The transcript beside the player is its caption, read by the board as the player moves, so no <track> is attached. -->
    <!-- eslint-disable-next-line vuejs-accessibility/media-has-caption -->
    <audio
      ref="element"
      class="audio"
      controls
      preload="metadata"
      :src="props.src"
      :aria-label="label"
      data-testid="audio-player"
      @timeupdate="tell"
      @seeked="tell"
    />
  </div>
</template>

<style scoped>
.player {
  display: grid;
}

.audio {
  width: 100%;
  max-width: 560px;
}
</style>
