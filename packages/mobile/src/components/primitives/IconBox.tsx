import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface IconBoxProps {
  children: React.ReactNode;
  size?: number;
}

export function IconBox({ children, size = 34 }: IconBoxProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.box, { width: size, height: size, backgroundColor: colors.iconBg }]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
});
