import { TextStyle } from 'react-native';

export const fontFamilies = {
  display: 'SpaceGrotesk_400Regular',
  displayMedium: 'SpaceGrotesk_500Medium',
  displayBold: 'SpaceGrotesk_700Bold',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemiBold: 'Inter_600SemiBold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

export const textStyles = {
  displayLarge: {
    fontFamily: fontFamilies.display,
    fontSize: 32,
    lineHeight: 35,
    letterSpacing: -0.025 * 32,
  } satisfies TextStyle,

  displayMedium: {
    fontFamily: fontFamilies.display,
    fontSize: 26,
    lineHeight: 29,
    letterSpacing: -0.02 * 26,
  } satisfies TextStyle,

  displaySmall: {
    fontFamily: fontFamilies.display,
    fontSize: 22,
    lineHeight: 26,
    letterSpacing: -0.015 * 22,
  } satisfies TextStyle,

  heading: {
    fontFamily: fontFamilies.displayMedium,
    fontSize: 20,
    lineHeight: 24,
    letterSpacing: -0.01 * 20,
  } satisfies TextStyle,

  title: {
    fontFamily: fontFamilies.display,
    fontSize: 18,
    lineHeight: 22,
    letterSpacing: -0.01 * 18,
  } satisfies TextStyle,

  body: {
    fontFamily: fontFamilies.body,
    fontSize: 14.5,
    lineHeight: 22,
  } satisfies TextStyle,

  bodySmall: {
    fontFamily: fontFamilies.body,
    fontSize: 13.5,
    lineHeight: 20,
  } satisfies TextStyle,

  bodyReader: {
    fontFamily: fontFamilies.body,
    fontSize: 16,
    lineHeight: 26,
  } satisfies TextStyle,

  label: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 14,
    lineHeight: 18,
  } satisfies TextStyle,

  eyebrow: {
    fontFamily: fontFamilies.mono,
    fontSize: 10,
    letterSpacing: 0.12 * 10,
    textTransform: 'uppercase',
  } satisfies TextStyle,

  meta: {
    fontFamily: fontFamilies.mono,
    fontSize: 11,
    letterSpacing: 0.02 * 11,
  } satisfies TextStyle,

  metaSmall: {
    fontFamily: fontFamilies.mono,
    fontSize: 10.5,
    letterSpacing: 0.04 * 10.5,
  } satisfies TextStyle,

  timer: {
    fontFamily: fontFamilies.mono,
    fontSize: 56,
    fontWeight: '300',
    letterSpacing: -0.02 * 56,
  } satisfies TextStyle,
} as const;
