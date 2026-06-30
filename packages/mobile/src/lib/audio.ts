import { Audio } from 'expo-av';
import { config } from './config';
import type { VoiceCaptureResponse } from './types';

const RECORDING_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: true,
  android: {
    extension: '.m4a',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: '.m4a',
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  web: { mimeType: 'audio/webm', bitsPerSecond: 128000 },
};

export async function requestMicPermission(): Promise<boolean> {
  const { status } = await Audio.requestPermissionsAsync();
  return status === 'granted';
}

export async function startRecording(): Promise<Audio.Recording> {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
  });
  const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
  return recording;
}

export async function stopRecording(recording: Audio.Recording): Promise<string> {
  await recording.stopAndUnloadAsync();
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
  const uri = recording.getURI();
  if (!uri) throw new Error('Recording URI is null');
  return uri;
}

export async function uploadAudio(
  uri: string,
  brainView: string = 'personal',
): Promise<VoiceCaptureResponse> {
  const formData = new FormData();

  // React Native FormData accepts { uri, name, type } objects
  formData.append('file', {
    uri,
    name: 'recording.m4a',
    type: 'audio/mp4',
  } as unknown as Blob);

  formData.append('brain_view', brainView);
  formData.append('device', 'mobile_app');

  // INT-M5: send the voice-capture Bearer when configured.
  const headers: Record<string, string> = {};
  if (config.voiceCaptureSecret) {
    headers['Authorization'] = `Bearer ${config.voiceCaptureSecret}`;
  }

  const response = await fetch(`${config.voiceCaptureUrl}/api/capture`, {
    method: 'POST',
    body: formData,
    headers,
    // Do NOT set Content-Type — fetch sets it with multipart boundary
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Voice upload failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<VoiceCaptureResponse>;
}
