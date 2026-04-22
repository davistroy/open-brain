/** @type {import('jest').Config} */
module.exports = {
  // Use babel-jest with the expo babel preset for TS/JSX support.
  // We avoid the full jest-expo preset because its setupFiles deeply require
  // react-native internals (NativeModules) that fail under pnpm's .pnpm
  // hoisted directory structure.
  transform: {
    '\\.[jt]sx?$': ['babel-jest', {
      caller: { name: 'metro', bundler: 'metro', platform: 'ios' },
    }],
  },
  // Allow babel-jest to transform RN ecosystem packages (pnpm-aware).
  transformIgnorePatterns: [
    'node_modules/(?!(.pnpm|react-native|@react-native|expo|@expo|lucide-react-native|react-native-reanimated|react-native-screens|react-native-safe-area-context|react-native-svg|@tanstack|expo-blur|expo-haptics|expo-font|expo-router|expo-splash-screen|expo-status-bar|expo-linear-gradient|expo-secure-store|expo-av|expo-modules-core|@react-navigation|@expo-google-fonts|@testing-library)/)',
  ],
  // Mock react-native with a lightweight shim. The full RN module
  // can't be required outside jest-expo's environment, but our tests
  // only need View, Text, Pressable, StyleSheet, and useColorScheme.
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__mocks__/react-native.js',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: [
    '**/__tests__/**/*.[jt]s?(x)',
    '**/?(*.)+(spec|test).[jt]s?(x)',
  ],
};
