import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface StatItem { value: string; label: string }

export function StatsGrid({ items }: { items: StatItem[] }) {
  const { colors, text } = useTheme();
  return (
    <View style={styles.grid}>
      {items.map(item => (
        <View key={item.label} style={[styles.cell, { backgroundColor: colors.cardBg, borderColor: colors.hairline }]}>
          <Text style={[text.displaySmall, { color: colors.ink }]}>{item.value}</Text>
          <Text style={[text.eyebrow, { color: colors.secondary, marginTop: 2, marginBottom: 0, fontSize: 10 }]}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 8, marginBottom: 22 },
  cell: { flex: 1, borderWidth: 1, padding: 12, alignItems: 'center' },
});
