import React from 'react';
import { Text, TextStyle } from 'react-native';
import { useTheme } from '../../theme/theme';

interface MEyebrowProps {
  children: React.ReactNode;
  color?: string;
  style?: TextStyle;
}

export function MEyebrow({ children, color, style }: MEyebrowProps) {
  const { colors, text } = useTheme();
  return (
    <Text style={[text.eyebrow, { color: color ?? colors.accent, marginBottom: 6 }, style]}>
      {children}
    </Text>
  );
}
