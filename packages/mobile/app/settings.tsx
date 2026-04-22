import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Mic, Brain, Sparkles, Mail, Calendar, Sun, Type, Lock, Download, ChevronRight } from 'lucide-react-native';
import { useTheme } from '../src/theme/theme';
import { TopBar } from '../src/components/shell/TopBar';
import { MCard } from '../src/components/primitives/MCard';
import { SettingsSection } from '../src/components/settings/SettingsSection';
import { SettingsRow } from '../src/components/settings/SettingsRow';
import { Toggle } from '../src/components/settings/Toggle';

export default function SettingsScreen() {
  const { colors, text } = useTheme();
  const Chev = () => <ChevronRight size={16} strokeWidth={1.6} color={colors.secondary} />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TopBar eyebrow="ACCOUNT · TROY @ OPEN BRAIN" title="Settings" />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
        <MCard style={{ ...styles.profileCard, marginBottom: 22 }}>
          <View style={[styles.avatar, { backgroundColor: colors.accent }]}>
            <Text style={{ color: '#FFF', fontFamily: text.displayMedium.fontFamily, fontSize: 20 }}>T</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[text.title, { color: colors.ink, fontSize: 17 }]}>Troy Davis</Text>
            <Text style={[text.meta, { color: colors.secondary, marginTop: 2 }]}>troy@openbrain.co</Text>
          </View>
          <Chev />
        </MCard>

        <SettingsSection label="Capture">
          <SettingsRow icon={<Mic size={14} strokeWidth={1.5} color={colors.body} />} title="Voice transcription" subtitle="Whisper large-v3 · server" right={<Toggle value={true} />} />
          <SettingsRow icon={<Brain size={14} strokeWidth={1.5} color={colors.body} />} title="Auto-extract entities" right={<Toggle value={true} />} />
          <SettingsRow icon={<Sparkles size={14} strokeWidth={1.5} color={colors.body} />} title="Daily brief" subtitle="Generate at 7:00 AM" right={<Toggle value={true} />} last />
        </SettingsSection>

        <SettingsSection label="Sources">
          <SettingsRow icon={<Mail size={14} strokeWidth={1.5} color={colors.body} />} title="Email" subtitle="brain@troy-davis.com" right={<Chev />} />
          <SettingsRow icon={<Calendar size={14} strokeWidth={1.5} color={colors.body} />} title="Slack" subtitle="Connected" right={<Chev />} last />
        </SettingsSection>

        <SettingsSection label="Appearance">
          <SettingsRow icon={<Sun size={14} strokeWidth={1.5} color={colors.body} />} title="Theme" subtitle="System" right={<Chev />} />
          <SettingsRow icon={<Type size={14} strokeWidth={1.5} color={colors.body} />} title="Reading size" subtitle="Medium" right={<Chev />} last />
        </SettingsSection>

        <SettingsSection label="Privacy">
          <SettingsRow icon={<Lock size={14} strokeWidth={1.5} color={colors.body} />} title="Self-hosted" subtitle="Data on your homeserver" right={<Chev />} />
          <SettingsRow icon={<Download size={14} strokeWidth={1.5} color={colors.body} />} title="Export all data" subtitle="JSON" right={<Chev />} last />
        </SettingsSection>

        <Text style={[text.metaSmall, { color: colors.secondary, textAlign: 'center', marginTop: 16 }]}>
          OPEN BRAIN · v0.1.0
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  profileCard: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
});
