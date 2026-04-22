import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';
import { IconBox } from './IconBox';

interface ListRowProps {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  last?: boolean;
  onPress?: () => void;
}

export function ListRow({ icon, title, subtitle, right, last, onPress }: ListRowProps) {
  const { colors, fonts } = useTheme();

  const content = (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline }]}>
      {icon && <IconBox>{icon}</IconBox>}
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.ink, fontFamily: fonts.bodyMedium }]} numberOfLines={1}>{title}</Text>
        {subtitle && <Text style={[styles.sub, { color: colors.secondary, fontFamily: fonts.mono }]}>{subtitle}</Text>}
      </View>
      {right}
    </View>
  );

  if (onPress) return <Pressable onPress={onPress}>{content}</Pressable>;
  return content;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14 },
  sub: { fontSize: 11, marginTop: 2 },
});
