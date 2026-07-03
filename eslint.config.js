'use strict'

const js = require('@eslint/js')
const nodePlugin = require('eslint-plugin-n')
const importX = require('eslint-plugin-import-x')
const prettier = require('eslint-config-prettier')
const globals = require('globals')

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

  // Base recommendations
  js.configs.recommended,
  importX.flatConfigs.recommended,
  nodePlugin.configs['flat/recommended-script'],

  // Project configuration — CommonJS library targeting Node >= 20.
  // Formatting is owned by Prettier (see the eslint-config-prettier block last),
  // so the rules here are limited to correctness and code-quality concerns.
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      // Declarations & variables
      'no-var': 'error',
      'prefer-const': 'error',
      'one-var': ['error', 'never'],
      'no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      'no-use-before-define': [
        'error',
        { functions: false, classes: false, variables: false },
      ],
      'no-shadow': 'error',

      // Correctness & best practices
      eqeqeq: ['error', 'smart'],
      'no-console': ['error', { allow: ['warn'] }],
      'no-bitwise': 'error',
      'no-nested-ternary': 'error',
      'no-unneeded-ternary': 'error',
      'no-else-return': 'error',
      'no-lonely-if': 'error',
      'consistent-return': 'error',
      'default-case-last': 'error',
      'grouped-accessor-pairs': 'error',
      'dot-notation': 'error',
      radix: 'error',
      'no-throw-literal': 'error',
      'no-await-in-loop': 'error',
      'no-restricted-syntax': [
        'error',
        'ForInStatement',
        'LabeledStatement',
        'WithStatement',
      ],
      'max-classes-per-file': 'error',
      'lines-between-class-members': [
        'error',
        'always',
        { exceptAfterSingleLine: true },
      ],

      // ES2015+ idioms
      'prefer-arrow-callback': 'error',
      'prefer-template': 'error',
      'prefer-spread': 'error',
      'object-shorthand': ['error', 'always'],

      // Import hygiene (import-x)
      'import-x/no-extraneous-dependencies': 'error',
      'import-x/no-dynamic-require': 'error',

      // Relaxed recommended rules:
      // - no-prototype-builtins: the codebase intentionally calls obj.hasOwnProperty().
      // - no-useless-assignment / no-unassigned-vars: newer, control-flow-aggressive
      //   rules that here only flag pre-existing WIP patterns (e.g. lib/csv/stream-converter).
      'no-prototype-builtins': 'off',
      'no-useless-assignment': 'off',
      'no-unassigned-vars': 'off',
    },
  },

  // Build & tooling scripts — allow console, process.exit, and devDependency imports.
  {
    files: ['scripts/**/*.js', 'eslint.config.js', 'benchmark.js'],
    rules: {
      'no-console': 'off',
      'no-shadow': 'off',
      'n/no-process-exit': 'off',
      'import-x/no-extraneous-dependencies': [
        'error',
        { devDependencies: true },
      ],
    },
  },

  // Mocha + Chai specs — provide test globals and relax fixture-heavy rules.
  {
    files: ['spec/**/*.js'],
    languageOptions: {
      globals: { ...globals.mocha, expect: 'readonly', verquire: 'readonly' },
    },
    rules: {
      'no-sparse-arrays': 'off',
      'import-x/no-extraneous-dependencies': [
        'error',
        { devDependencies: true },
      ],
    },
  },

  // Standalone manual test scripts under test/.
  {
    files: ['test/**/*.js'],
    rules: {
      'no-console': 'off',
      'n/no-process-exit': 'off',
      'n/no-unpublished-require': 'off',
      'import-x/no-extraneous-dependencies': [
        'error',
        { devDependencies: true },
      ],
    },
  },

  // verquire conditionally requires the built CJS output (dist/cjs), a generated
  // artifact that is absent unless `yarn build` has run.
  {
    files: ['spec/utils/verquire.js'],
    rules: {
      'import-x/no-unresolved': 'off',
      'n/no-missing-require': 'off',
    },
  },

  // Prettier last — turn off every stylistic rule Prettier already enforces.
  prettier,
]
