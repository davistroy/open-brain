const DEFAULT_API_URL = 'https://brain.troy-davis.com/api/v1';
const DEFAULT_VOICE_URL = 'http://homeserver.k4jda.net:3001';

export const config = {
  get apiBaseUrl(): string {
    return process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API_URL;
  },
  get voiceCaptureUrl(): string {
    return process.env.EXPO_PUBLIC_VOICE_URL ?? DEFAULT_VOICE_URL;
  },
  // INT-M5: Bearer for the voice-capture service. Bundled into the app (EXPO_PUBLIC_*
  // is client-visible) — acceptable for a single-user shared secret. Unset = no header
  // (works against a pre-rollout voice-capture that warn-and-allows).
  get voiceCaptureSecret(): string | undefined {
    return process.env.EXPO_PUBLIC_VOICE_SECRET || undefined;
  },
};
