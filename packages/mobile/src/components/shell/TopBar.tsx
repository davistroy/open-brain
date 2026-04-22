import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/theme';

interface TopBarProps {
  eyebrow?: string;
  title?: string;
  leftAction?: React.ReactNode;
  rightAction?: React.ReactNode;
}

export function TopBar({ eyebrow, title, leftAction, rightAction }: TopBarProps) {
  const { colors, text } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, {
      paddingTop: insets.top + 14,
      backgroundColor: colors.bg,
      borderBottomColor: colors.hairline,
    }]}>
      <View style={styles.inner}>
        <View style={styles.left}>
          {leftAction && !title && leftAction}
          {eyebrow && (
            <Text style={[text.eyebrow, { color: colors.accent, marginBottom: 4 }]}>{eyebrow}</Text>
          )}
          {title && (
            <Text style={[text.displayMedium, { color: colors.ink }]}>{title}</Text>
          )}
        </View>
        {rightAction && <View style={styles.right}>{rightAction}</View>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  inner: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  left: { flex: 1, minWidth: 0 },
  right: { paddingBottom: 4 },
});
