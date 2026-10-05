<script setup lang="ts">
// <AudioPlayer>: the browser's own audio player over the meeting's audio: a curated sample's file
// served by the site, or the visitor's recording held in the browser as an object URL. It never
// fetches anything from the back end (the back end deletes the audio once transcribed, so there is
// nothing to fetch). The transcript and the items ask it to jump to a second and play, and it tells
// the board the second it is at, so the segment being heard can be shown.
//
// A browser can only jump into a file it is streaming when the server answers byte ranges, and a
// server that does not (the site's own, in the test build or self-hosted) leaves the audio unseekable:
// every jump would start it from the beginning. So a sample's file, at most a few hundred kilobytes,
// is read once into the page's memory and played from there, where any second can be reached; if it
// cannot be read, the player streams it as before. A jump asked for before the audio is ready is
// kept and made as soon as it can be.
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  /** The address of the audio, or undefined before there is any. */
  src: string | undefined
  /** Names the player for assistive tech. */
  label: string
}>()

const emit = defineEmits<{ time: [seconds: number] }>()

/** The most a site file held in memory may weigh: the samples are a few hundred kilobytes. */
const MAX_HELD_BYTES = 8 * 1024 * 1024

const element = ref<HTMLAudioElement>()
// The address the element plays: the given one, or a copy of a site file held in memory.
const playable = ref<string>()
// A copy this player made, to let go of when it is done with it.
let held: string | undefined
// A jump asked for before the audio could be sought, made when it can.
let pending: { seconds: number, play: boolean } | undefined
// Which source is current: an answer for an older one is dropped.
let generation = 0

/** Lets go of the copy this player made, if any. */
function letGo(): void {
  if (held !== undefined && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(held)
  held = undefined
}

/** Reads a site file into memory and returns an address for the copy, or undefined when it cannot be read. */
async function holdInMemory(src: string): Promise<string | undefined> {
  if (typeof fetch !== 'function' || typeof URL.createObjectURL !== 'function') return undefined
  try {
    const response = await fetch(src)
    const type = response.headers.get('content-type') ?? ''
    if (!response.ok || !type.startsWith('audio/')) return undefined
    const blob = await response.blob()
    if (blob.size === 0 || blob.size > MAX_HELD_BYTES) return undefined
    return URL.createObjectURL(blob)
  }
  catch {
    return undefined
  }
}

/** Plays a new source: a recording in the browser as it is, a site file from memory once it has been read. */
async function take(src: string | undefined): Promise<void> {
  generation += 1
  const current = generation
  letGo()
  pending = undefined
  if (src === undefined || !src.startsWith('/')) {
    playable.value = src
    return
  }
  playable.value = undefined
  const copy = await holdInMemory(src)
  if (current !== generation) {
    if (copy !== undefined && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(copy)
    return
  }
  held = copy
  playable.value = copy ?? src
}

watch(() => props.src, src => void take(src), { immediate: true })

/** Tells whether the audio can be sought to a second now. */
function canSeek(audio: HTMLAudioElement, seconds: number): boolean {
  if (audio.readyState < 1 || !audio.seekable) return false
  for (let index = 0; index < audio.seekable.length; index += 1) {
    if (seconds >= audio.seekable.start(index) && seconds <= audio.seekable.end(index)) return true
  }
  return false
}

/** Starts playing, where the browser lets a page; a refusal is not an error worth showing. */
function play(audio: HTMLAudioElement): void {
  if (typeof audio.play !== 'function') return
  try {
    const playing = audio.play()
    if (playing && typeof playing.catch === 'function') playing.catch(() => undefined)
  }
  catch {
    // A browser that will not play without a gesture, or has no sound output.
  }
}

/** Jumps to a second of the audio, and plays from there when asked; before the audio is ready, as soon as it is. */
function seekTo(seconds: number, andPlay: boolean): void {
  const target = Math.max(seconds, 0)
  // The board marks what is being heard at once, whether or not the audio can move there yet.
  emit('time', target)
  const audio = element.value
  if (!audio || !canSeek(audio, target)) {
    pending = { seconds: target, play: andPlay }
    return
  }
  pending = undefined
  audio.currentTime = target
  if (andPlay) play(audio)
}

/** Makes a jump that was waiting for the audio, once it can be sought. */
function ready(): void {
  const audio = element.value
  const waiting = pending
  if (!audio || !waiting || !canSeek(audio, waiting.seconds)) return
  pending = undefined
  audio.currentTime = waiting.seconds
  if (waiting.play) play(audio)
}

/** Says where the playback is. */
function tell(): void {
  const audio = element.value
  if (audio) emit('time', audio.currentTime)
}

onBeforeUnmount(() => {
  generation += 1
  letGo()
})

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
      :src="playable"
      :aria-label="label"
      data-testid="audio-player"
      :data-source="src"
      @loadedmetadata="ready"
      @canplay="ready"
      @progress="ready"
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
