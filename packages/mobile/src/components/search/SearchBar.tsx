import React from 'react';
import { View, TextInput, Text, Pressable, StyleSheet } from 'react-native';
import { Search as SearchIcon } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/theme';

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  hitCount?: number;
  onCancel: () => void;
}

export function SearchBar({ value, onChangeText, hitCount, onCancel }: SearchBarProps) {
  const { colors, text } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12, borderBottomColor: colors.hairline }]}>
      <View style={[styles.inputWrap, { backgroundColor: colors.iconBg, borderColor: colors.hairline }]}>
        <SearchIcon size={16} strokeWidth={1.6} color={colors.secondary} />
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder="Search captures, entities..."
          placeholderTextColor={colors.secondary}
          style={[styles.input, { color: colors.ink }]}
          autoFocus
          returnKeyType="search"
        />
        {hitCount !== undefined && (
          <Text style={[text.eyebrow, { color: colors.secondary, marginBottom: 0 }]}>{hitCount} HITS</Text>
        )}
      </View>
      <Pressable onPress={onCancel}>
        <Text style={[{ color: colors.accent, fontSize: 14, fontWeight: '500' }]}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 16, paddingBottom: 14, flexDirection: 'row', gap: 10, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  inputWrap: { flex: 1, height: 40, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderWidth: 1 },
  input: { flex: 1, fontSize: 15 },
});
