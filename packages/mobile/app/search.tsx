import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../src/theme/theme';
import { MCard } from '../src/components/primitives/MCard';
import { MEyebrow } from '../src/components/primitives/MEyebrow';
import { SearchBar } from '../src/components/search/SearchBar';
import { ScopeChips } from '../src/components/search/ScopeChips';
import { useSearch } from '../src/hooks/useSearch';

export default function SearchScreen() {
  const { colors, text } = useTheme();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const { data } = useSearch(query, { limit: 20 });

  const results = data?.results ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SearchBar
        value={query}
        onChangeText={setQuery}
        hitCount={data?.total}
        onCancel={() => router.back()}
      />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
        <ScopeChips
          scopes={[
            { label: 'All', count: data?.total ?? 0 },
            { label: 'Captures', count: results.length },
          ]}
          activeIndex={0}
          onSelect={() => {}}
        />

        <MEyebrow color={colors.secondary}>Results</MEyebrow>
        <MCard padding={0}>
          {results.map((r, i) => (
            <View key={r.capture.id} style={[
              styles.result,
              i < results.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
            ]}>
              <View style={styles.resultHeader}>
                <Text style={[text.eyebrow, { color: colors.secondary, marginBottom: 0 }]}>{r.capture.source.toUpperCase()}</Text>
                <Text style={[text.meta, { color: colors.secondary }]}>
                  {new Date(r.capture.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </Text>
              </View>
              <Text style={[text.label, { color: colors.ink, marginBottom: 3 }]} numberOfLines={1}>
                {r.capture.title ?? r.capture.content.slice(0, 60)}
              </Text>
              <Text style={[text.bodySmall, { color: colors.body }]} numberOfLines={2}>
                {r.capture.content.slice(0, 150)}
              </Text>
            </View>
          ))}
        </MCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  result: { padding: 12, paddingHorizontal: 16 },
  resultHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 4 },
});
