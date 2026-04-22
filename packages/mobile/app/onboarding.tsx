import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Mic } from 'lucide-react-native';
import { useTheme } from '../src/theme/theme';
import { MCard } from '../src/components/primitives/MCard';
import { MEyebrow } from '../src/components/primitives/MEyebrow';

const STEPS = [
  { n: '01', t: 'Capture', d: 'Voice · text · photo · link' },
  { n: '02', t: 'Link', d: 'Entities & past captures, automatic' },
  { n: '03', t: 'Brief', d: 'Daily synthesis at 7:00 AM' },
];

export default function OnboardingScreen() {
  const { colors, text } = useTheme();
  const router = useRouter();

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <View style={styles.content}>
        <MEyebrow style={{ textAlign: 'center', marginBottom: 18 }}>A fresh slate · no captures yet</MEyebrow>

        <Text style={[text.displayLarge, { color: colors.ink, textAlign: 'center', marginBottom: 16 }]}>
          Start with a thought.{'\n'}Open Brain does the rest.
        </Text>

        <Text style={[text.body, { color: colors.body, textAlign: 'center', maxWidth: 320, marginBottom: 36, lineHeight: 23 }]}>
          Speak, type, or drop anything in. We'll transcribe, extract the people and projects inside, and thread it to what you've said before.
        </Text>

        <View style={styles.stepsWrap}>
          {STEPS.map(step => (
            <MCard key={step.n} style={styles.step}>
              <View style={styles.stepInner}>
                <Text style={[text.eyebrow, { color: colors.accent, minWidth: 22, marginBottom: 0 }]}>{step.n}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[text.label, { color: colors.ink, fontWeight: '500', fontSize: 15 }]}>{step.t}</Text>
                  <Text style={[text.meta, { color: colors.secondary }]}>{step.d}</Text>
                </View>
              </View>
            </MCard>
          ))}
        </View>

        <Pressable
          onPress={() => router.push('/record')}
          style={[styles.cta, { backgroundColor: colors.accent }]}
        >
          <Mic size={17} strokeWidth={1.8} color="#FFFFFF" />
          <Text style={styles.ctaText}>Record your first thought</Text>
        </Pressable>

        <Text style={[text.metaSmall, { color: colors.secondary, marginTop: 14 }]}>
          OR TYPE · IMPORT · CONNECT A SOURCE
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, paddingTop: 80 },
  stepsWrap: { gap: 10, width: '100%', maxWidth: 320, marginBottom: 36 },
  step: { padding: 12 },
  stepInner: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  cta: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 16, paddingHorizontal: 36,
    shadowColor: '#CC785C', shadowOpacity: 0.32, shadowRadius: 18, shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  ctaText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
