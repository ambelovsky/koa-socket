/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-env commonjs, node */

module.exports = {
  clearMocks: true,
  collectCoverage: true,
  moduleFileExtensions: ['js', 'ts'],
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  testRunner: 'jest-circus/runner',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  verbose: true,
};
