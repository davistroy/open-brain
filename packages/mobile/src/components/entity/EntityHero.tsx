import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface EntityHeroProps {
  name: string;
  entityType: string;
  subType?: string;
  subtitle?: string;
  captureCount: number;
}

export function EntityHero({ name, entityType, subType, subtitle, captureCount }: EntityHeroProps) {
  const { colors, text } = useTheme();
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <View style={[styles.row, { borderBottomColor: colors.hairline }]}>
      <View style={[styles.avatar, { backgroundColor: colors.accentLight }]}>
        <Text style={[{ fontFamily: text.displayMedium.fontFamily, fontSize: 24, color: colors.accentDarker }]}>{initials}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[text.eyebrow, { color: colors.secondary, marginBottom: 4 }]}>
          {entityType.toUpperCase()}{subType ? ` · ${subType.toUpperCase()}` : ''}
        </Text>
        <Text style={[text.displaySmall, { color: colors.ink }]}>{name}</Text>
        {subtitle && <Text style={[text.meta, { color: colors.secondary, marginTop: 2 }]}>{subtitle} · {captureCount} captures</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 14, alignItems: 'center', marginBottom: 20, paddingBottom: 20, borderBottomWidth: 1 },
  avatar: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
});
