import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { palette } from './tokens';
import { spacing, contentPadding, tabBarHeight } from './spacing';
import { textStyles, fontFamilies } from './typography';

const lightColors = {
  ink: palette.slateDark,
  body: palette.slateLight,
  secondary: palette.cloudDark,
  hairline: palette.cloudLight,
  cardBg: palette.white,
  bg: palette.ivoryMedium,

  accent: palette.bookCloth,
  accentDark: palette.bookClothDark,
  accentDarker: palette.bookClothDarker,
  accentLight: palette.bookCloth50,
  accentLighter: palette.bookCloth100,

  tabBarBg: 'rgba(240,238,230,0.92)',
  tabBarBorder: 'rgba(20,20,19,0.08)',

  iconBg: palette.ivoryMedium,
  successText: '#4A6B3A',
  warnText: '#8B6F3A',
};

const darkColors = {
  ink: palette.darkInk,
  body: palette.darkBody,
  secondary: palette.darkSecondary,
  hairline: 'rgba(240,238,230,0.08)',
  cardBg: palette.darkCard,
  bg: palette.darkBg,

  accent: palette.bookCloth,
  accentDark: palette.bookClothDark,
  accentDarker: palette.bookClothDarker,
  accentLight: palette.bookCloth50,
  accentLighter: palette.bookCloth100,

  tabBarBg: 'rgba(20,20,19,0.92)',
  tabBarBorder: 'rgba(240,238,230,0.08)',

  iconBg: palette.darkSurface,
  successText: '#9CB890',
  warnText: '#C9A66B',
};

export type ThemeColors = Record<keyof typeof lightColors, string>;

export interface Theme {
  dark: boolean;
  colors: ThemeColors;
  spacing: typeof spacing;
  contentPadding: typeof contentPadding;
  tabBarHeight: number;
  text: typeof textStyles;
  fonts: typeof fontFamilies;
}

export const lightTheme: Theme = {
  dark: false,
  colors: lightColors,
  spacing,
  contentPadding,
  tabBarHeight,
  text: textStyles,
  fonts: fontFamilies,
};

export const darkTheme: Theme = {
  dark: true,
  colors: darkColors,
  spacing,
  contentPadding,
  tabBarHeight,
  text: textStyles,
  fonts: fontFamilies,
};

const ThemeContext = createContext<Theme>(lightTheme);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const colorScheme = useColorScheme();
  const theme = useMemo(
    () => (colorScheme === 'dark' ? darkTheme : lightTheme),
    [colorScheme],
  );
  return React.createElement(ThemeContext.Provider, { value: theme }, children);
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
