import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, Bookmark } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme/theme';
import { MEyebrow } from '../../src/components/primitives/MEyebrow';
import { Hairline } from '../../src/components/primitives/Hairline';
import { DropCap } from '../../src/components/briefs/DropCap';
import { useBrief } from '../../src/hooks/useBriefs';

export default function BriefReaderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, text, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data } = useBrief(id);

  const brief = data?.brief;
  const title = typeof brief?.title === 'string' ? brief.title : '';
  const bodyHtml = typeof brief?.body_html === 'string' ? brief.body_html : '';
  const kind = typeof brief?.kind === 'string' ? brief.kind : 'BRIEF';
  const generatedAt = typeof brief?.generated_at === 'string' ? brief.generated_at : (brief?.created_at as string ?? '');

  const dt = generatedAt ? new Date(generatedAt) : new Date();
  const eyebrow = `${kind} · ${dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()}`;

  const bg = dark ? '#141413' : '#FAFAF7';

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <View style={[styles.stickyNav, { paddingTop: insets.top + 12, backgroundColor: bg, borderBottomColor: colors.hairline }]}>
        <Pressable onPress={() => router.back()} style={{ padding: 6 }}>
          <ChevronLeft size={22} strokeWidth={1.8} color={colors.ink} />
        </Pressable>
        <Text style={[text.eyebrow, { color: colors.secondary }]}>{eyebrow}</Text>
        <Pressable style={{ padding: 6 }}>
          <Bookmark size={20} strokeWidth={1.6} color={colors.ink} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 120 }}>
        <MEyebrow>{eyebrow}</MEyebrow>
        <Text style={[text.displayLarge, { color: colors.ink, marginBottom: 16 }]}>{title}</Text>
        <Hairline />

        <View style={{ marginTop: 28 }}>
          <Text style={[text.bodyReader, { color: dark ? '#D6D4CA' : colors.body }]}>
            {bodyHtml ? bodyHtml.replace(/<[^>]*>/g, '') : 'Loading brief content...'}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  stickyNav: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
