import React from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface Column { name: string; count: number }

interface ColumnTabsProps {
  columns: Column[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

export function ColumnTabs({ columns, activeIndex, onSelect }: ColumnTabsProps) {
  const { colors, text } = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: colors.hairline }]}>
      {columns.map((col, i) => (
        <Pressable key={col.name} onPress={() => onSelect(i)} style={[
          styles.tab,
          i === activeIndex && { borderBottomWidth: 2, borderBottomColor: colors.accent },
        ]}>
          <Text style={[text.eyebrow, {
            color: i === activeIndex ? colors.ink : colors.secondary,
            fontWeight: i === activeIndex ? '500' : '400',
            marginBottom: 0,
          }]}>
            {col.name} <Text style={{ color: colors.secondary }}>{col.count}</Text>
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 0, borderBottomWidth: 1, marginBottom: 20 },
  tab: { paddingVertical: 10, paddingRight: 14, marginRight: 20, marginBottom: -1 },
});
