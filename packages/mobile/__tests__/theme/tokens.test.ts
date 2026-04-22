import { lightTheme, darkTheme } from '../../src/theme/theme';

describe('theme tokens', () => {
  const requiredColorKeys = [
    'ink', 'body', 'secondary', 'hairline', 'cardBg', 'bg',
    'accent', 'accentDark', 'accentDarker', 'accentLight', 'accentLighter',
    'tabBarBg', 'tabBarBorder',
    'iconBg', 'successText', 'warnText',
  ];

  test('light theme has all required semantic colors', () => {
    for (const key of requiredColorKeys) {
      expect(lightTheme.colors).toHaveProperty(key);
      expect(typeof (lightTheme.colors as Record<string, string>)[key]).toBe('string');
    }
  });

  test('dark theme has all required semantic colors', () => {
    for (const key of requiredColorKeys) {
      expect(darkTheme.colors).toHaveProperty(key);
      expect(typeof (darkTheme.colors as Record<string, string>)[key]).toBe('string');
    }
  });

  test('light and dark themes have identical color key sets', () => {
    const lightKeys = Object.keys(lightTheme.colors).sort();
    const darkKeys = Object.keys(darkTheme.colors).sort();
    expect(lightKeys).toEqual(darkKeys);
  });
});
