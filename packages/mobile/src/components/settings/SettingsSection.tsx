import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme/theme';
import { MEyebrow } from '../primitives/MEyebrow';
import { MCard } from '../primitives/MCard';

export function SettingsSection({ label, children }: { label: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ marginBottom: 22 }}>
      <MEyebrow color={colors.secondary} style={{ paddingHorizontal: 4 }}>{label}</MEyebrow>
      <MCard padding={0}>{children}</MCard>
    </View>
  );
}
