/**
 * ESLint setup for every TypeScript and Vue package in the repository.
 *
 * One tool lints and formats (ESLint Stylistic), so there is no separate formatter.
 * On top of Nuxt's defaults it enforces the owner's two house rules:
 * - every function, class, method and type carries a doc comment saying what it does;
 * - security first: no eval-like code, no regexes open to catastrophic backtracking,
 *   no hidden Unicode tricks, no markup built from strings.
 */
import { createConfigForNuxt } from '@nuxt/eslint-config/flat'
import security from 'eslint-plugin-security'
import vueA11y from 'eslint-plugin-vuejs-accessibility'

// Where a doc comment is required, beyond function declarations, classes and methods:
// functions stored in top-level constants, and named types.
const documentedContexts = [
  'Program > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression',
  'Program > VariableDeclaration > VariableDeclarator > FunctionExpression',
  'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression',
  'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > FunctionExpression',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
]

export default createConfigForNuxt({
  features: {
    stylistic: true,
    typescript: true,
    // JSDoc checks and eslint-plugin-regexp (which catches regexes open to ReDoS).
    tooling: { jsdoc: true, regexp: true, unicorn: false },
  },
  dirs: {
    // Nuxt apps and layers, so pages, layouts and error pages get Nuxt's naming rules.
    src: ['apps/web/app', 'packages/ui/app'],
  },
})
  // Files a script writes (openapi-typescript's types, the route table) are checked for drift by
  // `pnpm check`, not read by hand, so they are not linted.
  .append({ ignores: ['packages/api-clients/src/generated/**'] })
  .append(vueA11y.configs['flat/recommended'])
  .append({
    name: 'lb/security',
    plugins: { security },
    rules: {
      // docs/SECURITY.md: no visitor or model text is ever parsed as markup.
      'vue/no-v-html': 'error',
      // Nothing builds and runs code from strings.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      // A curated set: the rules that find real problems without flagging every
      // property access (detect-object-injection) or every CLI path argument.
      'security/detect-bidi-characters': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-child-process': 'error',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-non-literal-regexp': 'error',
      'security/detect-non-literal-require': 'error',
      'security/detect-possible-timing-attacks': 'error',
      'security/detect-pseudoRandomBytes': 'error',
    },
  })
  .append({
    name: 'lb/documentation',
    rules: {
      // The owner reads the code by its comments: every function, class, method and
      // type says what it does, and editors show that text on hover.
      'jsdoc/require-jsdoc': ['error', {
        publicOnly: false,
        require: {
          FunctionDeclaration: true,
          ClassDeclaration: true,
          MethodDefinition: true,
          ArrowFunctionExpression: false,
          FunctionExpression: false,
        },
        contexts: documentedContexts,
        checkConstructors: false,
        enableFixer: false,
      }],
      'jsdoc/require-description': ['error', {
        contexts: ['FunctionDeclaration', 'ClassDeclaration', 'MethodDefinition', ...documentedContexts],
      }],
    },
  })
