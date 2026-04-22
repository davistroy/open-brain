import React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { useTheme } from '../../src/theme/theme';
import { TopBar } from '../../src/components/shell/TopBar';
import { MCard } from '../../src/components/primitives/MCard';
import { MEyebrow } from '../../src/components/primitives/MEyebrow';
import { BriefListItem } from '../../src/components/briefs/BriefListItem';
import { useBriefs } from '../../src/hooks/useBriefs';

export default function BriefsScreen() {
  const { colors, tabBarHeight } = useTheme();
  const router = useRouter();
  const { data } = useBriefs({ limit: 20 });

  const items = data?.items ?? [];

  const todayBriefs = items.filter(b => {
    const d = new Date(b.generated_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });
  const weekBriefs = items.filter(b => {
    const d = new Date(b.generated_at);
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return d > weekAgo && d.toDateString() !== now.toDateString();
  });
  const earlierBriefs = items.filter(b => {
    const d = new Date(b.generated_at);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return d <= weekAgo;
  });

  const sections = [
    { label: 'Today', items: todayBriefs },
    { label: 'This week', items: weekBriefs },
    { label: 'Earlier', items: earlierBriefs },
  ].filter(s => s.items.length > 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        eyebrow={`${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()} · ${items.filter(b => !b.read_at).length} UNREAD`}
        title="Briefs"
        rightAction={
          <Pressable style={{ padding: 8, paddingHorizontal: 12, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Plus size={13} strokeWidth={2.2} color="#FFF" />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 20 }}>
        {sections.map(section => (
          <View key={section.label} style={{ marginBottom: 24 }}>
            <MEyebrow color={colors.secondary}>{section.label}</MEyebrow>
            <MCard padding={0}>
              {section.items.map((brief, i) => (
                <BriefListItem
                  key={brief.id}
                  kind={brief.kind}
                  title={brief.title}
                  meta={brief.subtitle || new Date(brief.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  isAccent={section.label === 'Today' && i === 0}
                  last={i === section.items.length - 1}
                  onPress={() => router.push(`/briefs/${brief.id}`)}
                />
              ))}
            </MCard>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
