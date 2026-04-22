import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface DropCapProps {
  letter: string;
  children: React.ReactNode;
}

export function DropCap({ letter, children }: DropCapProps) {
  const { colors, fonts } = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.letter, { color: colors.accent, fontFamily: fonts.display }]}>{letter}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  letter: { fontSize: 56, lineHeight: 50, marginRight: 8, marginTop: 6 },
});
