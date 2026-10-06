import { register } from 'tsconfig-paths';

/**
 * Resolves the `@domain/*`, `@application/*`… aliases at runtime for the compiled build
 * (`node dist/...`). Under tsx/Jest the aliases are resolved by the tooling instead.
 * Must be the first import of every entry point.
 */
if (__filename.endsWith('.js')) {
  register({
    baseUrl: __dirname,
    paths: {
      '@domain/*': ['domain/*'],
      '@application/*': ['application/*'],
      '@infrastructure/*': ['infrastructure/*'],
      '@presentation/*': ['presentation/*'],
    },
    addMatchAll: false,
  });
}
