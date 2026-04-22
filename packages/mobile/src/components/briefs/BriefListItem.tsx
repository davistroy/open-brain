import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/theme';

interface BriefListItemProps {
  kind: string;
  title: string;
  meta: string;
  isAccent?: boolean;
  progress?: number;
  last?: boolean;
  onPress?: () => void;
}

export function BriefListItem({ kind, title, meta, isAccent, progress, last, onPress }: BriefListItemProps) {
  const { colors, text } = useTheme();

  return (
    <Pressable onPress={onPress} style={[
      styles.item,
      !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
    ]}>
      {isAccent && <View style={[styles.accentRail, { backgroundColor: colors.accent }]} />}
      <Text style={[text.eyebrow, { color: isAccent ? colors.accent : colors.secondary, marginBottom: 6 }]}>
        {kind}
      </Text>
      <Text style={[text.title, { color: colors.ink, fontSize: 16, marginBottom: 6 }]}>{title}</Text>
      <Text style={[text.meta, { color: colors.secondary }]}>{meta}</Text>
      {progress !== undefined && (
        <View style={[styles.progressTrack, { backgroundColor: colors.iconBg, marginTop: 10 }]}>
          <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: colors.accent }]} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  item: { padding: 16, position: 'relative' },
  accentRail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 2 },
  progressTrack: { height: 2 },
  progressFill: { height: '100%' },
});
