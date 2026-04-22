import React from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, Mic, Mail, FileUp } from 'lucide-react-native';
import { useTheme } from '../../src/theme/theme';
import { TopBar } from '../../src/components/shell/TopBar';
import { MCard } from '../../src/components/primitives/MCard';
import { MPill } from '../../src/components/primitives/MPill';
import { SectionHeader } from '../../src/components/primitives/SectionHeader';
import { IconBox } from '../../src/components/primitives/IconBox';
import { HeroRecordButton } from '../../src/components/capture/HeroRecordButton';
import { QuickCaptureGrid } from '../../src/components/capture/QuickCaptureGrid';
import { useCaptures } from '../../src/hooks/useCaptures';
import { useBriefs } from '../../src/hooks/useBriefs';

export default function HomeScreen() {
  const { colors, text, tabBarHeight } = useTheme();
  const router = useRouter();
  const { data: capturesData } = useCaptures({ limit: 3 });
  const { data: briefsData } = useBriefs({ limit: 1 });

  const now = new Date();
  const dayLabel = now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const dateLabel = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  const timeLabel = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  const latestBrief = briefsData?.items?.[0];

  const sourceIcon = (source: string) => {
    switch (source) {
      case 'voice': return Mic;
      case 'email': return Mail;
      default: return FileUp;
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        eyebrow={`${dayLabel} · ${dateLabel} · ${timeLabel}`}
        title={`Good ${now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening'}, Troy.`}
        rightAction={
          <Pressable style={[styles.iconBtn, { backgroundColor: colors.iconBg }]}>
            <Bell size={16} strokeWidth={1.6} color={colors.ink} />
          </Pressable>
        }
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 20 }}
      >
        <Text style={[text.body, { color: colors.secondary, marginBottom: 28, marginTop: -4 }]}>
          {capturesData?.total
            ? `${capturesData.total} total captures`
            : 'Loading captures...'}
        </Text>

        <MCard style={{ marginBottom: 24 }}>
          <HeroRecordButton onPress={() => router.push('/record')} />
        </MCard>

        <View style={{ marginBottom: 28 }}>
          <QuickCaptureGrid />
        </View>

        {latestBrief && (
          <View style={{ marginBottom: 24 }}>
            <SectionHeader label="Today's brief" actionLabel="OPEN →" onAction={() => router.push(`/briefs/${latestBrief.id}`)} />
            <MCard>
              <Text style={[text.title, { color: colors.ink, marginBottom: 10 }]}>{latestBrief.title}</Text>
              <Text style={[text.bodySmall, { color: colors.body, marginBottom: 14 }]}>{latestBrief.subtitle}</Text>
              <View style={[styles.tagRow, { borderTopColor: colors.hairline }]}>
                <MPill tone="accent">Brief</MPill>
              </View>
            </MCard>
          </View>
        )}

        <View style={{ marginBottom: 20 }}>
          <SectionHeader label="Recent" actionLabel="ALL →" onAction={() => router.push('/(tabs)/library')} />
          <MCard padding={0}>
            {capturesData?.items.map((capture, i) => {
              const Icon = sourceIcon(capture.source);
              return (
                <View key={capture.id} style={[
                  styles.captureRow,
                  i < (capturesData.items.length - 1) && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
                ]}>
                  <IconBox><Icon size={15} strokeWidth={1.5} color={colors.body} /></IconBox>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.captureTitle, { color: colors.ink }]} numberOfLines={1}>
                      {capture.title ?? capture.content.slice(0, 60)}
                    </Text>
                    <Text style={[text.meta, { color: colors.secondary }]}>
                      {capture.entities?.slice(0, 2).join(' · ') ?? capture.source}
                    </Text>
                  </View>
                  <Text style={[text.meta, { color: colors.secondary }]}>
                    {new Date(capture.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </Text>
                </View>
              );
            })}
          </MCard>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  iconBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  tagRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  captureRow: { flexDirection: 'row', gap: 12, paddingVertical: 14, paddingHorizontal: 16 },
  captureTitle: { fontSize: 14, fontWeight: '500', marginBottom: 2 },
});
