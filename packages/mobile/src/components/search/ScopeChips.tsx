import React from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface ScopeChipsProps {
  scopes: Array<{ label: string; count: number }>;
  activeIndex: number;
  onSelect: (index: number) => void;
}

export function ScopeChips({ scopes, activeIndex, onSelect }: ScopeChipsProps) {
  const { colors, text } = useTheme();
  return (
    <View style={styles.row}>
      {scopes.map((scope, i) => (
        <Pressable
          key={scope.label}
          onPress={() => onSelect(i)}
          style={[styles.chip, {
            backgroundColor: i === activeIndex ? colors.accent : colors.iconBg,
            borderColor: i === activeIndex ? colors.accent : colors.hairline,
          }]}
        >
          <Text style={[text.meta, {
            color: i === activeIndex ? '#FFFFFF' : colors.body,
          }]}>{scope.label.toUpperCase()} · {scope.count}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 20 },
  chip: { paddingVertical: 6, paddingHorizontal: 11, borderWidth: 1 },
});
