import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

export function Hairline() {
  const { colors } = useTheme();
  return <View style={[styles.line, { backgroundColor: colors.hairline }]} />;
}

const styles = StyleSheet.create({
  line: { height: StyleSheet.hairlineWidth },
});
