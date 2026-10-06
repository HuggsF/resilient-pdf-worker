// ESLint 9 flat config. The legacy `.eslintrc.json` format is no longer supported by ESLint 9.
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const LAYER_ALIASES = {
  application: '@application/*',
  infrastructure: '@infrastructure/*',
  presentation: '@presentation/*',
};

/** Domain may only import from itself: no frameworks, no Node built-ins, no outer layers. */
const domainBoundary = {
  files: ['src/domain/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            regex: '^(?!@domain/|\\.{1,2}/).*',
            message: 'Domain layer must have ZERO external dependencies (Clean Architecture dependency rule).',
          },
        ],
      },
    ],
  },
};

/** Application may depend on Domain only. */
const applicationBoundary = {
  files: ['src/application/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [LAYER_ALIASES.infrastructure, LAYER_ALIASES.presentation],
            message: 'Application layer may only depend on the Domain layer.',
          },
          {
            regex: '^(?!@domain/|@application/|\\.{1,2}/).*',
            message: 'Application layer must not import frameworks or Node built-ins — declare a port instead.',
          },
        ],
      },
    ],
  },
};

/** Infrastructure must never reach into Presentation. */
const infrastructureBoundary = {
  files: ['src/infrastructure/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      { patterns: [{ group: [LAYER_ALIASES.presentation], message: 'Infrastructure must not depend on Presentation.' }] },
    ],
  },
};

/** The chaos server simulates a third-party API: it must not share code with the application. */
const chaosBoundary = {
  files: ['chaos/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            regex: '^(@domain|@application|@infrastructure|@presentation)/|\\.\\./src/',
            message: 'The flaky PDF server is an external service: keep it independent from src/.',
          },
        ],
      },
    ],
  },
};

export default tseslint.config(
  { ignores: ['dist/', 'dist-chaos/', 'coverage/', 'node_modules/'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportDefaultDeclaration', message: 'Use named exports only.' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' }],
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true, allowTypedFunctionExpressions: true }],
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  domainBoundary,
  applicationBoundary,
  infrastructureBoundary,
  chaosBoundary,
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    files: ['eslint.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
