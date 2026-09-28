import { createConfigForNuxt } from '@nuxt/eslint-config/flat'
import vueA11y from 'eslint-plugin-vuejs-accessibility'

// One lint setup for every TypeScript and Vue package. The stylistic rules also format
// the code, so there is no separate formatter.
export default createConfigForNuxt({
  features: {
    stylistic: true,
    typescript: true,
  },
})
  .append(vueA11y.configs['flat/recommended'])
  .append({
    rules: {
      // docs/SECURITY.md: no visitor or model text is ever parsed as markup.
      'vue/no-v-html': 'error',
    },
  })
