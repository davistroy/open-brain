import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';
import { IconBox } from '../primitives/IconBox';

interface SettingsRowProps {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  last?: boolean;
}

export function SettingsRow({ icon, title, subtitle, right, last }: SettingsRowProps) {
  const { colors, text } = useTheme();
  return (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline }]}>
      {icon && <IconBox size={30}>{icon}</IconBox>}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[text.label, { color: colors.ink, fontSize: 14.5 }]}>{title}</Text>
        {subtitle && <Text style={[text.meta, { color: colors.secondary, marginTop: 2 }]}>{subtitle}</Text>}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 14, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 },
});
