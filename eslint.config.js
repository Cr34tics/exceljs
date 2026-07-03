const { FlatCompat } = require('@eslint/eslintrc')
const js = require('@eslint/js')
const nodePlugin = require('eslint-plugin-n')
const prettierConfig = require('eslint-config-prettier')
const globals = require('globals')

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
})

module.exports = [
  // Ignores (replaces .eslintignore)
  {
    ignores: [
      'build/**',
      'dist/**',
      'out/**',
      'spec/manual/public/**',
      'scripts/shims/**',
      'scripts/empty-module.js',
    ],
  },

  // Airbnb base via FlatCompat (legacy config bridge)
  ...compat.extends('airbnb-base'),

  // Node plugin recommended for CommonJS scripts
  nodePlugin.configs['flat/recommended-script'],

  // Prettier config (disables formatting rules that conflict with Prettier)
  prettierConfig,

  // Project-specific configuration
  {
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.es2015,
        ...globals.mocha,
        ...globals.node,
      },
    },
    rules: {
      'arrow-parens': ['error', 'as-needed'],
      'class-methods-use-this': ['off'],
      'comma-dangle': [
        'error',
        {
          arrays: 'always-multiline',
          objects: 'always-multiline',
          imports: 'always-multiline',
          exports: 'always-multiline',
          functions: 'never',
        },
      ],
      'default-case': ['off'],
      'func-names': ['off', 'never'],
      'global-require': ['off'],
      'max-len': [
        'error',
        { code: 120, ignoreComments: true, ignoreStrings: true },
      ],
      'no-console': ['error', { allow: ['warn'] }],
      'no-continue': ['off'],
      'no-mixed-operators': ['error', { allowSamePrecedence: true }],
      'no-multi-assign': ['off'],
      'no-param-reassign': ['off'],
      'no-path-concat': ['off'],
      'no-plusplus': ['off'],
      'no-prototype-builtins': ['off'],
      'no-restricted-syntax': [
        'error',
        'ForInStatement',
        'LabeledStatement',
        'WithStatement',
      ],
      'no-return-assign': ['off'],
      'no-trailing-spaces': ['error', { skipBlankLines: true }],
      'no-underscore-dangle': [
        'off',
        { allowAfterThis: true, allowAfterSuper: true },
      ],
      'no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'none',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      // The codebase intentionally uses explicit .js/.json extensions in require() paths.
      'import/extensions': 'off',
      'no-use-before-define': [
        'error',
        { variables: false, classes: false, functions: false },
      ],
      'n/no-unsupported-features/es-syntax': [
        'error',
        { version: '>=10.0.0', ignores: [] },
      ],
      'n/process-exit-as-throw': ['off'],
      'object-curly-spacing': ['error', 'never'],
      'object-property-newline': [
        'off',
        { allowMultiplePropertiesPerLine: true },
      ],
      'prefer-destructuring': ['warn', { array: false, object: true }],
      'prefer-object-spread': ['off'],
      'prefer-rest-params': ['off'],
      quotes: ['error', 'single'],
      semi: ['error', 'always'],
      'space-before-function-paren': [
        'error',
        { anonymous: 'never', named: 'never', asyncArrow: 'always' },
      ],
      strict: ['off'],
    },
  },

  // Override for build/test scripts — allow console, process.exit, and devDependency imports
  {
    files: ['scripts/**/*.js'],
    rules: {
      'no-console': 'off',
      'n/no-process-exit': 'off',
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      'no-shadow': 'off',
    },
  },

  // Test specs (Mocha + Chai). Mirrors the legacy spec/.eslintrc that the flat-config
  // migration left orphaned: provides the chai `expect` and the `verquire` helper as
  // globals, allows devDependency imports, and relaxes rules that are noisy in fixtures.
  {
    files: ['spec/**/*.js'],
    languageOptions: {
      globals: {
        expect: 'readonly',
        verquire: 'readonly',
      },
    },
    rules: {
      'no-new': 'off',
      'max-len': 'off',
      'brace-style': 'off',
      'array-bracket-spacing': 'off',
      'no-sparse-arrays': 'off',
      'object-property-newline': 'off',
      'prefer-object-spread': 'off',
      'no-underscore-dangle': 'off',
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
    },
  },

  // Standalone manual test scripts under test/ (mirrors the legacy test/.eslintrc).
  // These are ad-hoc CLI scripts that call process.exit and require lib/ directly.
  {
    files: ['test/**/*.js'],
    rules: {
      'no-new': 'off',
      'max-len': 'off',
      'no-console': 'off',
      'no-underscore-dangle': 'off',
      'spaced-comment': 'off',
      'n/no-process-exit': 'off',
      'n/no-unpublished-require': 'off',
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
    },
  },

  // Root-level tooling / CLI scripts — allow devDependency imports and process.exit.
  {
    files: ['eslint.config.js', 'benchmark.js'],
    rules: {
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      'n/no-process-exit': 'off',
    },
  },

  // verquire conditionally requires the built CJS output (dist/cjs), a generated
  // artifact that is absent unless `yarn build` has run — don't resolve it at lint time.
  {
    files: ['spec/utils/verquire.js'],
    rules: {
      'import/no-unresolved': 'off',
      'n/no-missing-require': 'off',
    },
  },
]
