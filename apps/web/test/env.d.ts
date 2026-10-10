// What the plain TypeScript check of the tests (tsconfig.tools.json) needs to know about files it
// cannot read: single-file components, which the tests import and mount, and the build flag the
// bundler replaces. The components themselves are type-checked by vue-tsc in `nuxt typecheck`.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

/** True in the end-to-end test build and in most Vitest projects, false in a production build. */
declare const __LB_TEST_BUILD__: boolean
