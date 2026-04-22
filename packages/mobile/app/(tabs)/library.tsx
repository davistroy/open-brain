import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { SlidersHorizontal, Mic, Mail, FileUp, Edit3, Calendar } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/theme/theme';
import { TopBar } from '../../src/components/shell/TopBar';
import { MCard } from '../../src/components/primitives/MCard';
import { MPill } from '../../src/components/primitives/MPill';
import { MEyebrow } from '../../src/components/primitives/MEyebrow';
import { IconBox } from '../../src/components/primitives/IconBox';
import { useCaptures } from '../../src/hooks/useCaptures';

const SOURCE_ICONS: Record<string, typeof Mic> = { voice: Mic, email: Mail, file: FileUp, api: Edit3, document: FileUp, slack: Calendar };

export default function LibraryScreen() {
  const { colors, text, tabBarHeight } = useTheme();
  const router = useRouter();
  const { data } = useCaptures({ limit: 30 });

  const items = data?.items ?? [];

  const grouped = items.reduce<Record<string, typeof items>>((acc, cap) => {
    const dateKey = new Date(cap.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
    (acc[dateKey] ??= []).push(cap);
    return acc;
  }, {});

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        eyebrow={`${data?.total ?? 0} TOTAL`}
        title="Timeline"
        rightAction={
          <Pressable style={{ padding: 6 }}>
            <SlidersHorizontal size={18} strokeWidth={1.6} color={colors.ink} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 20 }}>
        {Object.entries(grouped).map(([dateKey, captures]) => (
          <View key={dateKey} style={{ marginBottom: 20 }}>
            <MEyebrow color={colors.secondary} style={{ letterSpacing: 1.4 }}>{dateKey}</MEyebrow>
            <MCard padding={0}>
              {captures.map((cap, i) => {
                const Icon = SOURCE_ICONS[cap.source] ?? FileUp;
                return (
                  <View key={cap.id} style={[
                    styles.captureRow,
                    i < captures.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
                  ]}>
                    <IconBox size={30}><Icon size={14} strokeWidth={1.5} color={colors.body} /></IconBox>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={styles.titleRow}>
                        <Text style={[text.label, { color: colors.ink, flex: 1 }]} numberOfLines={1}>
                          {cap.title ?? cap.content.slice(0, 60)}
                        </Text>
                        <Text style={[text.meta, { color: colors.secondary }]}>
                          {new Date(cap.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
                        </Text>
                      </View>
                      <Text style={[text.bodySmall, { color: colors.body, marginBottom: 8 }]} numberOfLines={2}>
                        {cap.snippet ?? cap.content.slice(0, 120)}
                      </Text>
                      <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
                        {cap.entities?.slice(0, 3).map(e => <MPill key={e}>{e}</MPill>)}
                      </View>
                    </View>
                  </View>
                );
              })}
            </MCard>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  captureRow: { padding: 14, paddingHorizontal: 16 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 3 },
});
