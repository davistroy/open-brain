import { useMutation, useQueryClient } from '@tanstack/react-query'
import { voiceCapturesApi } from './voice-captures'
import type { VoiceCaptureOptions } from './voice-captures'

export function useVoiceCapture() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, opts }: { file: File; opts?: VoiceCaptureOptions }) =>
      voiceCapturesApi.upload(file, opts),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['captures', 'list'] })
    },
  })
}
