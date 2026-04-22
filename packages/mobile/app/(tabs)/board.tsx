import React, { useState } from 'react';
import { View, ScrollView, Pressable, Text, StyleSheet } from 'react-native';
import { Filter, Plus } from 'lucide-react-native';
import { useTheme } from '../../src/theme/theme';
import { TopBar } from '../../src/components/shell/TopBar';
import { MCard } from '../../src/components/primitives/MCard';
import { MEyebrow } from '../../src/components/primitives/MEyebrow';
import { ColumnTabs } from '../../src/components/board/ColumnTabs';
import { DecisionCard } from '../../src/components/board/DecisionCard';
import { useCommitments, usePatchCommitment } from '../../src/hooks/useCommitments';

export default function BoardScreen() {
  const { colors, text, tabBarHeight } = useTheme();
  const [activeCol, setActiveCol] = useState(0);
  const { data: pendingData } = useCommitments({ status: 'pending', limit: 20 });
  const { data: waitingData } = useCommitments({ status: 'waiting_on', limit: 20 });
  const { data: resolvedData } = useCommitments({ status: 'resolved', limit: 10 });
  const patchMutation = usePatchCommitment();

  const columns = [
    { name: 'Open', count: pendingData?.total ?? 0 },
    { name: 'Pondering', count: waitingData?.total ?? 0 },
    { name: 'Decided', count: resolvedData?.total ?? 0 },
  ];

  const activeItems = activeCol === 0
    ? (pendingData?.items ?? [])
    : activeCol === 1
    ? (waitingData?.items ?? [])
    : (resolvedData?.items ?? []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar
        eyebrow={`${(pendingData?.total ?? 0) + (waitingData?.total ?? 0) + (resolvedData?.total ?? 0)} TOTAL`}
        title="Board"
        rightAction={
          <Pressable style={{ padding: 6 }}>
            <Filter size={18} strokeWidth={1.6} color={colors.ink} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: tabBarHeight + 20 }}>
        <ColumnTabs columns={columns} activeIndex={activeCol} onSelect={setActiveCol} />

        {activeItems.map(item => (
          <DecisionCard
            key={item.id}
            title={item.text}
            meta={`${item.entity_name ?? 'No entity'} · ${item.due_date ?? 'flexible'}`}
            priority={activeCol === 2 ? 'done' : (item.due_date && new Date(item.due_date) < new Date() ? 'high' : 'med')}
            onResolve={activeCol !== 2 ? () => patchMutation.mutate({ id: item.id, body: { status: 'resolved' } }) : undefined}
            onAdvance={activeCol === 0 ? () => patchMutation.mutate({ id: item.id, body: { status: 'waiting_on' } }) : undefined}
          />
        ))}

        {activeCol === 0 && (
          <Pressable style={[styles.addBtn, { borderColor: colors.hairline }]}>
            <Plus size={14} strokeWidth={1.6} color={colors.secondary} />
            <Text style={[text.bodySmall, { color: colors.secondary }]}>Add question</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  addBtn: { padding: 14, borderWidth: 1, borderStyle: 'dashed', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 4 },
});
