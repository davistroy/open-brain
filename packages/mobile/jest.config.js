/** @type {import('jest').Config} */
module.exports = {
  // Use babel-jest with the expo babel preset for TS/JSX support,
  // but skip the full jest-expo preset which requires native module mocks
  // that break under pnpm's .pnpm directory structure.
  transform: {
    '\\.[jt]sx?$': ['babel-jest', {
      caller: { name: 'metro', bundler: 'metro', platform: 'ios' },
    }],
  },
  // Mock react-native — our theme tests only need the type-level import
  // (TextStyle) and useColorScheme, both trivially mockable.
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__mocks__/react-native.js',
  },
  testMatch: [
    '**/__tests__/**/*.[jt]s?(x)',
    '**/?(*.)+(spec|test).[jt]s?(x)',
  ],
};
