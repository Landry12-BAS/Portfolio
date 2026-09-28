import { createConfigForNuxt } from '@nuxt/eslint-config/flat'
import vueA11y from 'eslint-plugin-vuejs-accessibility'

// One lint setup for every TypeScript and Vue package. The stylistic rules also format
// the code, so there is no separate formatter.
export default createConfigForNuxt({
  features: {
    stylistic: true,
    typescript: true,
  },
  dirs: {
    // Nuxt apps and layers, so pages, layouts and error pages get Nuxt's naming rules.
    src: ['apps/web/app', 'packages/ui/app'],
  },
})
  .append(vueA11y.configs['flat/recommended'])
  .append({
    rules: {
      // docs/SECURITY.md: no visitor or model text is ever parsed as markup.
      'vue/no-v-html': 'error',
    },
  })
