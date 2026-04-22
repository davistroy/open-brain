import React from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Mic } from 'lucide-react-native';
import { useTheme } from '../../theme/theme';

interface HeroRecordButtonProps {
  onPress: () => void;
}

export function HeroRecordButton({ onPress }: HeroRecordButtonProps) {
  const { colors, text, dark } = useTheme();
  const ringColor1 = dark ? 'rgba(204,120,92,0.14)' : 'rgba(204,120,92,0.16)';
  const ringColor2 = dark ? 'rgba(204,120,92,0.22)' : 'rgba(204,120,92,0.24)';

  return (
    <View style={styles.container}>
      <Text style={[text.eyebrow, { color: colors.accent, marginBottom: 18 }]}>
        Tap to capture · hold to speak
      </Text>
      <Pressable onPress={onPress} style={styles.buttonWrap}>
        <View style={[styles.outerRing, { borderColor: ringColor1 }]} />
        <View style={[styles.innerRing, { borderColor: ringColor2 }]} />
        <LinearGradient
          colors={['#D88967', '#CC785C', '#B25A3D']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.core}
        >
          <Mic size={44} strokeWidth={1.4} color="#FFFFFF" />
        </LinearGradient>
      </Pressable>
      <Text style={[text.title, { color: colors.ink, marginTop: 4 }]}>Record a thought</Text>
      <Text style={[text.metaSmall, { color: colors.secondary, marginTop: 4 }]}>
        AUTO-TRANSCRIBED · LINKED TO ENTITIES
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 24 },
  buttonWrap: { width: 180, height: 180, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  outerRing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 90,
    borderWidth: 1,
  },
  innerRing: {
    position: 'absolute',
    top: 18, left: 18, right: 18, bottom: 18,
    borderRadius: 72,
    borderWidth: 1,
  },
  core: {
    position: 'absolute',
    top: 36, left: 36, right: 36, bottom: 36,
    borderRadius: 54,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#CC785C',
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
});
