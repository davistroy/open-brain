import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface SectionHeaderProps {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function SectionHeader({ label, actionLabel, onAction }: SectionHeaderProps) {
  const { colors, text } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[text.eyebrow, { color: colors.secondary }]}>{label}</Text>
      {actionLabel && (
        <Pressable onPress={onAction}>
          <Text style={[text.meta, { color: colors.accent }]}>{actionLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 },
});
