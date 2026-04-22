// Minimal react-native mock for theme/pure-logic tests.
// The theme module imports useColorScheme and TextStyle (type-only at runtime).
// Component tests will use the full jest-expo preset via a separate config or
// by switching to @testing-library/react-native setup.
module.exports = {
  useColorScheme: jest.fn(() => 'light'),
  Platform: { OS: 'ios', select: jest.fn((obj) => obj.ios) },
  StyleSheet: { create: (styles) => styles },
};
