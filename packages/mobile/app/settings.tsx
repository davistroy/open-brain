import React, { useCallback, useEffect, useState } from 'react';
import { Alert, View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Mic, Brain, Sparkles, Mail, Calendar, Sun, Type, Lock, Download, ChevronRight, KeyRound, LogOut } from 'lucide-react-native';
import { useTheme } from '../src/theme/theme';
import { TopBar } from '../src/components/shell/TopBar';
import { MCard } from '../src/components/primitives/MCard';
import { SettingsSection } from '../src/components/settings/SettingsSection';
import { SettingsRow } from '../src/components/settings/SettingsRow';
import { Toggle } from '../src/components/settings/Toggle';
import { storage } from '../src/lib/storage';
import { clearTokenCache } from '../src/lib/api-client';

/** Token is 64 hex chars (openssl rand -hex 32). */
const TOKEN_LENGTH = 64;

function isValidToken(token: string): boolean {
  return token.length === TOKEN_LENGTH && /^[0-9a-f]+$/i.test(token);
}

export default function SettingsScreen() {
  const { colors, text } = useTheme();
  const Chev = () => <ChevronRight size={16} strokeWidth={1.6} color={colors.secondary} />;

  const [tokenStatus, setTokenStatus] = useState<'checking' | 'set' | 'missing'>('checking');
  const [pasteInput, setPasteInput] = useState('');
  const [pasteError, setPasteError] = useState('');
  const [showPasteInput, setShowPasteInput] = useState(false);

  const refreshTokenStatus = useCallback(async () => {
    const token = await storage.getApiToken();
    setTokenStatus(token ? 'set' : 'missing');
  }, []);

  useEffect(() => {
    void refreshTokenStatus();
  }, [refreshTokenStatus]);

  const handleSaveToken = useCallback(async () => {
    const trimmed = pasteInput.trim();
    if (!isValidToken(trimmed)) {
      setPasteError(`Token must be exactly ${TOKEN_LENGTH} lowercase hex characters.`);
      return;
    }
    await storage.setApiToken(trimmed);
    clearTokenCache();
    setPasteInput('');
    setPasteError('');
    setShowPasteInput(false);
    await refreshTokenStatus();
  }, [pasteInput, refreshTokenStatus]);

  const handleClearToken = useCallback(() => {
    Alert.alert(
      'Clear API Token',
      'This will log you out. You will need to paste the token again to reconnect.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await storage.deleteApiToken();
            clearTokenCache();
            setPasteInput('');
            setPasteError('');
            setShowPasteInput(false);
            await refreshTokenStatus();
          },
        },
      ]
    );
  }, [refreshTokenStatus]);

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

        <SettingsSection label="Connection">
          <SettingsRow
            icon={<KeyRound size={14} strokeWidth={1.5} color={colors.body} />}
            title="API Token"
            subtitle={tokenStatus === 'checking' ? 'Checking…' : tokenStatus === 'set' ? 'Configured' : 'Not set — tap to configure'}
            right={
              <Pressable onPress={() => setShowPasteInput(s => !s)}>
                <Chev />
              </Pressable>
            }
          />
          {showPasteInput && (
            <View style={styles.tokenInputWrap}>
              <TextInput
                style={[styles.tokenInput, { color: colors.ink, borderColor: pasteError ? '#D32F2F' : colors.secondary, backgroundColor: colors.bg }]}
                placeholder="Paste 64-char hex token from Bitwarden"
                placeholderTextColor={colors.secondary}
                value={pasteInput}
                onChangeText={t => { setPasteInput(t); setPasteError(''); }}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={false}
                returnKeyType="done"
                onSubmitEditing={handleSaveToken}
              />
              {pasteError ? <Text style={styles.errorText}>{pasteError}</Text> : null}
              <Pressable
                onPress={handleSaveToken}
                style={[styles.saveButton, { backgroundColor: colors.accent }]}
              >
                <Text style={styles.saveButtonText}>Save Token</Text>
              </Pressable>
            </View>
          )}
          <SettingsRow
            icon={<LogOut size={14} strokeWidth={1.5} color={colors.body} />}
            title="Clear API Token"
            subtitle="Log out and remove stored token"
            right={
              <Pressable onPress={handleClearToken}>
                <Chev />
              </Pressable>
            }
            last
          />
        </SettingsSection>

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
  tokenInputWrap: { paddingHorizontal: 14, paddingBottom: 12, gap: 8 },
  tokenInput: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    fontFamily: 'JetBrainsMono_400Regular',
  },
  errorText: { fontSize: 12, color: '#D32F2F' },
  saveButton: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 6,
    alignSelf: 'flex-end',
  },
  saveButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
});
