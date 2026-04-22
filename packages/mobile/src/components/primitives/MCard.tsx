import React from 'react';
import { View, ViewStyle, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface MCardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  padding?: number;
}

export function MCard({ children, style, padding = 16 }: MCardProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.hairline, padding }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1 },
});
