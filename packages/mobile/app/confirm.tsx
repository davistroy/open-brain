import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, Check } from 'lucide-react-native';
import { useTheme } from '../src/theme/theme';
import { TopBar } from '../src/components/shell/TopBar';
import { MCard } from '../src/components/primitives/MCard';
import { MEyebrow } from '../src/components/primitives/MEyebrow';
import { MButton } from '../src/components/primitives/MButton';

export default function ConfirmScreen() {
  const { colors, text } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{
    transcript: string;
    captureType: string;
    confidence: string;
    captureId: string;
    duration: string;
  }>();

  const durationLabel = params.duration
    ? `${Math.floor(Number(params.duration) / 60)}:${String(Math.round(Number(params.duration) % 60)).padStart(2, '0')}`
    : '0:00';

  const handleDiscard = () => {
    router.back();
  };

  const handleSave = () => {
    router.dismissAll();
    router.replace('/(tabs)');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        eyebrow={`VOICE · ${durationLabel} · AUTO-TRANSCRIBED`}
        title="Review capture"
        leftAction={
          <Pressable onPress={() => router.back()} style={{ padding: 0 }}>
            <ChevronLeft size={22} strokeWidth={1.8} color={colors.ink} />
          </Pressable>
        }
      />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
        <MCard style={{ marginBottom: 18 }}>
          <MEyebrow>Transcript</MEyebrow>
          <Text style={[text.body, { color: colors.body, lineHeight: 23 }]}>
            {params.transcript}
          </Text>
        </MCard>

        <View style={{ marginBottom: 18 }}>
          <MEyebrow color={colors.secondary}>Classification</MEyebrow>
          <MCard>
            <View style={styles.classRow}>
              <Text style={[text.label, { color: colors.ink }]}>{params.captureType}</Text>
              <Text style={[text.meta, { color: Number(params.confidence) > 0.9 ? colors.successText : colors.secondary }]}>
                {Math.round(Number(params.confidence) * 100)}%
              </Text>
            </View>
          </MCard>
        </View>

        <View style={[styles.actions, { marginTop: 24 }]}>
          <MButton variant="ghost" onPress={handleDiscard} style={{ flex: 1 }}>
            Discard
          </MButton>
          <MButton
            onPress={handleSave}
            icon={<Check size={15} strokeWidth={2.2} color="#FFFFFF" />}
            style={{ flex: 2 }}
          >
            Save capture
          </MButton>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  classRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actions: { flexDirection: 'row', gap: 8 },
});
