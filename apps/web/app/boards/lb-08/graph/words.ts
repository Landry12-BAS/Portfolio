// How the pure parts of the board (the canvas mapping, the log's sentences, the announcements)
// turn a key of the locale files into words without knowing about Vue: they are handed the two
// calls they need, `say` and `has`, and tests hand them a small table instead.

/** The two calls the pure parts of the board need from the locale files. */
export interface Words {
  // Writes the message of a key, with its parameters filled in.
  say: (key: string, params?: Record<string, string | number>) => string
  // Tells whether a key has a message, so a missing one can fall back instead of showing a key.
  has: (key: string) => boolean
}

/** Builds the two calls from vue-i18n's `t` and `te`. */
export function wordsFrom(
  translate: (key: string, params: Record<string, string | number>) => string,
  exists: (key: string) => boolean,
): Words {
  return {
    say: (key, params) => translate(key, params ?? {}),
    has: key => exists(key),
  }
}
