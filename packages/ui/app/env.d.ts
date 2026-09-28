// Vite resolves `?url` imports to the emitted file's public URL.
declare module '*.svg?url' {
  const src: string
  export default src
}
