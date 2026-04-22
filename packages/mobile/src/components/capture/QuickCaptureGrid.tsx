import React from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { Type, Camera, Link } from 'lucide-react-native';
import { useTheme } from '../../theme/theme';

const ITEMS = [
  { Icon: Type, label: 'Note' },
  { Icon: Camera, label: 'Photo' },
  { Icon: Link, label: 'Link' },
] as const;

export function QuickCaptureGrid() {
  const { colors, text } = useTheme();
  return (
    <View style={styles.grid}>
      {ITEMS.map((item) => (
        <Pressable
          key={item.label}
          style={[styles.cell, { backgroundColor: colors.cardBg, borderColor: colors.hairline }]}
        >
          <item.Icon size={18} strokeWidth={1.5} color={colors.ink} />
          <Text style={[text.eyebrow, { color: colors.secondary, fontSize: 10, marginBottom: 0 }]}>
            {item.label.toUpperCase()}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 8 },
  cell: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 14,
    borderWidth: 1,
  },
});
