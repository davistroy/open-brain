import React from 'react';
import { Pressable, Text, StyleSheet, ViewStyle } from 'react-native';
import { useTheme } from '../../theme/theme';

interface MButtonProps {
  children: React.ReactNode;
  onPress?: () => void;
  variant?: 'primary' | 'ghost';
  style?: ViewStyle;
  icon?: React.ReactNode;
}

export function MButton({ children, onPress, variant = 'primary', style, icon }: MButtonProps) {
  const { colors, fonts } = useTheme();
  const isPrimary = variant === 'primary';

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.button,
        {
          backgroundColor: isPrimary ? colors.accent : 'transparent',
          borderWidth: isPrimary ? 0 : 1,
          borderColor: isPrimary ? undefined : colors.hairline,
        },
        style,
      ]}
    >
      {icon}
      <Text style={[
        styles.text,
        {
          fontFamily: fonts.body,
          color: isPrimary ? '#FFFFFF' : colors.ink,
          fontWeight: isPrimary ? '600' : '500',
        },
      ]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  text: { fontSize: 14 },
});
