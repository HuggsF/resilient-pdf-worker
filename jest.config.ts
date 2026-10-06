import type { Config } from 'jest';

const moduleNameMapper: Record<string, string> = {
  '^@domain/(.*)$': '<rootDir>/src/domain/$1',
  '^@application/(.*)$': '<rootDir>/src/application/$1',
  '^@infrastructure/(.*)$': '<rootDir>/src/infrastructure/$1',
  '^@presentation/(.*)$': '<rootDir>/src/presentation/$1',
};

const transform: Config['transform'] = {
  '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
};

const baseProject = {
  testEnvironment: 'node',
  moduleNameMapper,
  transform,
  moduleFileExtensions: ['ts', 'js', 'json'],
};

const config: Config = {
  rootDir: '.',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/worker.ts',
    '!src/module-aliases.ts',
    '!src/presentation/cli/migrate.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageThreshold: {
    global: { statements: 80, branches: 80, functions: 80, lines: 80 },
    './src/domain/': { statements: 90, branches: 90, functions: 90, lines: 90 },
    './src/application/': { statements: 80, branches: 80, functions: 80, lines: 80 },
  },
  projects: [
    {
      ...baseProject,
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.spec.ts'],
    },
    {
      ...baseProject,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
    },
    {
      ...baseProject,
      displayName: 'e2e',
      testMatch: ['<rootDir>/tests/e2e/**/*.e2e.test.ts'],
    },
  ],
};

export default config;
