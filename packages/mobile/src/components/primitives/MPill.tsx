import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

type PillTone = 'neutral' | 'accent' | 'success' | 'warn';

interface MPillProps {
  children: React.ReactNode;
  tone?: PillTone;
}

export function MPill({ children, tone = 'neutral' }: MPillProps) {
  const { colors, dark, fonts } = useTheme();

  const toneMap = {
    neutral: {
      bg: dark ? '#262624' : '#E8E6DB',
      fg: colors.body,
      bd: colors.hairline,
    },
    accent: {
      bg: dark ? '#3A1F14' : colors.accentLight,
      fg: colors.accentDarker,
      bd: dark ? '#5A2D1F' : colors.accentLighter,
    },
    success: {
      bg: dark ? '#1E2A1A' : '#E8EEE5',
      fg: colors.successText,
      bd: dark ? '#2A3D24' : '#C8D5BF',
    },
    warn: {
      bg: dark ? '#2E2416' : '#F5EFE2',
      fg: colors.warnText,
      bd: dark ? '#3E3120' : '#D9C89C',
    },
  };

  const t = toneMap[tone];

  return (
    <View style={[styles.pill, { backgroundColor: t.bg, borderColor: t.bd }]}>
      <Text style={[styles.text, { color: t.fg, fontFamily: fonts.body }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderWidth: 1,
  },
  text: { fontSize: 11, fontWeight: '500' },
});
