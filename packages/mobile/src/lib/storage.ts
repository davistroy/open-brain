import * as SecureStore from 'expo-secure-store';

const KEYS = {
  API_TOKEN: 'ob_api_token',
  VOICE_URL: 'ob_voice_url',
} as const;

export const storage = {
  getApiToken: () => SecureStore.getItemAsync(KEYS.API_TOKEN),
  setApiToken: (token: string) => SecureStore.setItemAsync(KEYS.API_TOKEN, token),
  getVoiceUrl: () => SecureStore.getItemAsync(KEYS.VOICE_URL),
  setVoiceUrl: (url: string) => SecureStore.setItemAsync(KEYS.VOICE_URL, url),
};
