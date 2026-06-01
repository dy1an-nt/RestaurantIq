/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Ignore macOS AppleDouble metadata files (._foo.test.ts) on this volume.
  testPathIgnorePatterns: ['/node_modules/', '/\\._'],
  // Keep TS type-checking lenient in tests so mocks don't require full typing.
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        diagnostics: false,
      },
    ],
  },
  clearMocks: true,
};
