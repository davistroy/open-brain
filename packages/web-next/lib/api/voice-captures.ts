import { getApiBase } from './core'

export interface VoiceCaptureOptions {
  brain_view?: string
  device?: string
}

export interface VoiceCaptureResponse {
  ok: true
  capture: { id: string; pipeline_status: string; created_at: string }
  transcription: { text: string; duration: number; language?: string }
  classification: { template: string; confidence: number; brain_view: string }
}

export const voiceCapturesApi = {
  upload: async (file: File, opts: VoiceCaptureOptions = {}): Promise<VoiceCaptureResponse> => {
    const formData = new FormData()
    formData.append('file', file, file.name)
    if (opts.brain_view) formData.append('brain_view', opts.brain_view)
    if (opts.device) formData.append('device', opts.device)

    const url = `${getApiBase()}/voice-captures`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-Open-Brain-Caller': 'web-ui' },
      body: formData,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Voice capture failed: ${response.status} ${text}`)
    }
    return response.json()
  },
}
