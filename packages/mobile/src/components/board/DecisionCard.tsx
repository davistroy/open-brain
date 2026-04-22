import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Check, ArrowRight } from 'lucide-react-native';
import { useTheme } from '../../theme/theme';

interface DecisionCardProps {
  title: string;
  meta: string;
  priority: 'high' | 'med' | 'done';
  onResolve?: () => void;
  onAdvance?: () => void;
}

export function DecisionCard({ title, meta, priority, onResolve, onAdvance }: DecisionCardProps) {
  const { colors, text, dark } = useTheme();
  const railColor = priority === 'high' ? colors.accent : (dark ? '#3A3A36' : colors.secondary);

  return (
    <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.hairline }]}>
      <View style={[styles.rail, { backgroundColor: railColor }]} />
      <View style={{ marginLeft: 6, flex: 1 }}>
        <Text style={[text.eyebrow, { color: priority === 'high' ? colors.accent : colors.secondary, marginBottom: 6 }]}>
          {priority === 'high' ? 'HIGH PRIORITY' : priority === 'med' ? 'MEDIUM' : 'DECIDED'}
        </Text>
        <Text style={[text.title, { color: colors.ink, fontSize: 16, marginBottom: 10 }]}>{title}</Text>
        <View style={[styles.footer, { borderTopColor: colors.hairline }]}>
          <Text style={[text.meta, { color: colors.secondary, flex: 1 }]}>{meta}</Text>
          <View style={styles.actions}>
            {onResolve && (
              <Pressable style={{ padding: 4 }} onPress={onResolve}>
                <Check size={14} strokeWidth={1.8} color={colors.secondary} />
              </Pressable>
            )}
            {onAdvance && (
              <Pressable style={{ padding: 4 }} onPress={onAdvance}>
                <ArrowRight size={14} strokeWidth={1.8} color={colors.secondary} />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 16, marginBottom: 10, position: 'relative', flexDirection: 'row' },
  rail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  actions: { flexDirection: 'row', gap: 4 },
});
