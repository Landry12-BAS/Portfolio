// How the board writes seconds and moments: a second of the recording as minutes and seconds
// (`0:07`, `1:00`), the same whatever the language, so the transcript, the items and the player's
// labels agree with one another.

/** Writes a second of the recording as `m:ss`, rounded down to the second. */
export function clockTime(seconds: number): string {
  const whole = Math.max(Math.floor(seconds), 0)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

/** Tells whether a second of playback falls in a span of the recording: from its start up to, not including, its end. */
export function withinSpan(at: number, start: number, end: number): boolean {
  return at >= start && at < Math.max(end, start + 0.001)
}
