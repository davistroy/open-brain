import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface WaveformProps {
  metering: number;
  barCount?: number;
}

export function Waveform({ metering, barCount = 48 }: WaveformProps) {
  const { colors, dark } = useTheme();
  const normalizedLevel = Math.max(0, Math.min(1, (metering + 160) / 160));

  const bars = useMemo(() => {
    return Array.from({ length: barCount }, (_, i) => {
      const t = i / barCount;
      const base = 8 + Math.abs(Math.sin(t * 18) * Math.cos(t * 7) * 52);
      const isActive = i > barCount - 10;
      const height = Math.max(4, isActive ? base * normalizedLevel * 1.5 : base * 0.4);
      return { height, isActive };
    });
  }, [barCount, normalizedLevel]);

  return (
    <View style={styles.container}>
      {bars.map((bar, i) => (
        <View
          key={i}
          style={[
            styles.bar,
            {
              height: bar.height,
              backgroundColor: bar.isActive ? colors.accent : (dark ? '#3A3A36' : colors.secondary),
              opacity: bar.isActive ? 1 : 0.5,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, height: 120, paddingHorizontal: 24 },
  bar: { width: 3, borderRadius: 2 },
});
