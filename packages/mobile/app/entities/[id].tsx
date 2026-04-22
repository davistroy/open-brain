import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, MoreHorizontal } from 'lucide-react-native';
import { useTheme } from '../../src/theme/theme';
import { TopBar } from '../../src/components/shell/TopBar';
import { MCard } from '../../src/components/primitives/MCard';
import { MEyebrow } from '../../src/components/primitives/MEyebrow';
import { EntityHero } from '../../src/components/entity/EntityHero';
import { StatsGrid } from '../../src/components/entity/StatsGrid';
import { useEntity } from '../../src/hooks/useEntities';

export default function EntityDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, text } = useTheme();
  const router = useRouter();
  const { data: entity } = useEntity(id);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        leftAction={
          <Pressable onPress={() => router.back()}>
            <ChevronLeft size={22} strokeWidth={1.8} color={colors.ink} />
          </Pressable>
        }
        rightAction={
          <Pressable style={{ padding: 6 }}>
            <MoreHorizontal size={20} strokeWidth={1.6} color={colors.ink} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
        {entity && (
          <>
            <EntityHero
              name={entity.name}
              entityType={entity.entity_type}
              captureCount={entity.mention_count}
              subtitle={entity.blurb}
            />

            <StatsGrid items={[
              { value: String(entity.mention_count), label: 'Captures' },
              { value: String(entity.linked_captures?.length ?? 0), label: 'Links' },
              { value: String(entity.aliases?.length ?? 0), label: 'Aliases' },
            ]} />

            {entity.summary && (
              <MCard style={{ marginBottom: 22 }}>
                <MEyebrow>Synthesis</MEyebrow>
                <Text style={[text.body, { color: colors.body, lineHeight: 23 }]}>{entity.summary}</Text>
              </MCard>
            )}

            <MEyebrow color={colors.secondary}>Recent captures</MEyebrow>
            {entity.linked_captures?.slice(0, 10).map((cap, i) => (
              <View key={cap.id} style={[styles.captureRow, { borderBottomColor: colors.hairline }]}>
                <View style={styles.dot}>
                  <View style={[styles.dotInner, { backgroundColor: colors.accent }]} />
                  {i < Math.min((entity.linked_captures?.length ?? 0) - 1, 9) && (
                    <View style={[styles.line, { backgroundColor: colors.hairline }]} />
                  )}
                </View>
                <View style={{ flex: 1, paddingBottom: 6 }}>
                  <Text style={[text.metaSmall, { color: colors.secondary, marginBottom: 3 }]}>
                    {new Date(cap.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </Text>
                  <Text style={[text.label, { color: colors.ink, marginBottom: 2 }]} numberOfLines={1}>
                    {cap.content.slice(0, 80)}
                  </Text>
                  <Text style={[text.meta, { color: colors.secondary }]}>{cap.capture_type}</Text>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  captureRow: { flexDirection: 'row', gap: 14, paddingBottom: 18 },
  dot: { width: 10, paddingTop: 4, alignItems: 'center' },
  dotInner: { width: 8, height: 8, borderRadius: 4 },
  line: { width: 1, flex: 1, marginTop: 4 },
});
