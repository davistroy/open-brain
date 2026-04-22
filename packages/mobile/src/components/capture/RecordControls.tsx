import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { RotateCcw, Check } from 'lucide-react-native';
import { useTheme } from '../../theme/theme';

interface RecordControlsProps {
  onRestart: () => void;
  onStop: () => void;
  onConfirm: () => void;
}

export function RecordControls({ onRestart, onStop, onConfirm }: RecordControlsProps) {
  const { colors, dark } = useTheme();
  const borderColor = dark ? 'rgba(240,238,230,0.12)' : colors.secondary;

  return (
    <View style={[styles.container, { borderTopColor: colors.hairline, backgroundColor: dark ? '#141413' : '#FFFFFF' }]}>
      <Pressable style={[styles.sideBtn, { borderColor }]} onPress={onRestart}>
        <RotateCcw size={18} strokeWidth={1.6} color={colors.ink} />
      </Pressable>
      <Pressable style={styles.stopBtn} onPress={onStop}>
        <View style={[styles.stopOuter, { borderColor: dark ? '#0E0E0D' : '#F0EEE6' }]}>
          <View style={styles.stopSquare} />
        </View>
      </Pressable>
      <Pressable style={[styles.sideBtn, { borderColor }]} onPress={onConfirm}>
        <Check size={18} strokeWidth={1.8} color={colors.ink} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sideBtn: {
    width: 48, height: 48, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  stopBtn: { width: 68, height: 68 },
  stopOuter: {
    width: 68, height: 68, borderRadius: 34,
    backgroundColor: '#CC785C',
    borderWidth: 4,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#CC785C', shadowOpacity: 0.4, shadowRadius: 18, shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  stopSquare: { width: 22, height: 22, backgroundColor: '#FFFFFF' },
});
