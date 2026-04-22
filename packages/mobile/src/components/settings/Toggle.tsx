import React from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface ToggleProps {
  value: boolean;
  onValueChange?: (value: boolean) => void;
}

export function Toggle({ value, onValueChange }: ToggleProps) {
  const { colors, dark } = useTheme();
  return (
    <Pressable onPress={() => onValueChange?.(!value)} style={[styles.track, {
      backgroundColor: value ? colors.accent : (dark ? '#3A3A36' : colors.secondary),
    }]}>
      <View style={[styles.thumb, { left: value ? 20 : 2 }]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { width: 44, height: 26, borderRadius: 13, justifyContent: 'center' },
  thumb: { position: 'absolute', top: 2, width: 22, height: 22, borderRadius: 11, backgroundColor: '#FFF', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 3 },
});
