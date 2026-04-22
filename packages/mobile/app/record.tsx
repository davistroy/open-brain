import React from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../src/theme/theme';
import { Waveform } from '../src/components/capture/Waveform';
import { RecordControls } from '../src/components/capture/RecordControls';
import { useRecording } from '../src/hooks/useRecording';

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function RecordScreen() {
  const { colors, text, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { state, elapsed, metering, result, error, start, stop, reset } = useRecording();

  React.useEffect(() => {
    start();
  }, [start]);

  React.useEffect(() => {
    if (state === 'done' && result) {
      router.replace({
        pathname: '/confirm',
        params: {
          transcript: result.transcription.text,
          captureType: result.classification.template,
          confidence: String(result.classification.confidence),
          captureId: result.capture.id,
          duration: String(result.transcription.duration),
        },
      });
    }
  }, [state, result, router]);

  const bg = dark ? '#0E0E0D' : colors.bg;

  return (
    <View style={[styles.screen, { backgroundColor: bg }]}>
      <View style={[styles.topMeta, { paddingTop: insets.top + 16 }]}>
        <View>
          <Text style={[text.eyebrow, { color: colors.accent, marginBottom: 4 }]}>
            {state === 'recording' ? '● RECORDING' : state === 'uploading' ? '◉ TRANSCRIBING' : '○ READY'}
          </Text>
          <Text style={[text.meta, { color: colors.secondary }]}>
            {new Date().toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()} · {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
          </Text>
        </View>
        <Pressable style={{ padding: 8 }} onPress={() => { reset(); router.back(); }}>
          <X size={22} strokeWidth={1.6} color={colors.ink} />
        </Pressable>
      </View>

      <Text style={[text.timer, { color: colors.ink, textAlign: 'center', paddingTop: 40, paddingBottom: 8 }]}>
        {formatTime(elapsed)}
      </Text>
      <Text style={[text.metaSmall, { color: colors.secondary, textAlign: 'center', marginBottom: 32 }]}>
        {state === 'uploading' ? 'TRANSCRIBING · PLEASE WAIT' : 'ELAPSED · TAP TO PAUSE'}
      </Text>

      {state === 'uploading' ? (
        <View style={styles.spinner}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[text.meta, { color: colors.secondary, marginTop: 16 }]}>Sending to Whisper...</Text>
        </View>
      ) : (
        <Waveform metering={metering} />
      )}

      <View style={{ flex: 1 }} />

      {error && (
        <View style={styles.errorBox}>
          <Text style={[text.body, { color: '#BF4939' }]}>{error}</Text>
        </View>
      )}

      {state === 'recording' && (
        <RecordControls
          onRestart={() => { reset(); start(); }}
          onStop={stop}
          onConfirm={stop}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  topMeta: { paddingHorizontal: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  spinner: { alignItems: 'center', justifyContent: 'center', height: 120, paddingHorizontal: 24 },
  errorBox: { paddingHorizontal: 24, paddingVertical: 12 },
});
