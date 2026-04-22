/**
 * VoiceUpload page — upload a pre-recorded audio file to the voice-capture service.
 *
 * Server component shell: renders PageHeader + client-side upload widget.
 * The actual upload logic lives in components/voice/FileDropZone.tsx.
 *
 * Route: /voice-upload
 * Service: voice-capture (proxied via /voice-api/* rewrite in next.config.ts)
 */

import { Mic } from 'lucide-react';
import { PageHeader } from '@/components/design-system';
import { VoiceUploadClient } from '@/components/voice/VoiceUploadClient';

export default function VoiceUploadPage() {
  return (
    <>
      <PageHeader
        breadcrumb={['Open Brain', 'Voice Upload']}
        title="Voice Upload"
        subtitle="Upload a pre-recorded audio file — transcribed and captured automatically"
        actions={
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.04em] text-[var(--color-text-body-secondary)]">
            <Mic size={11} strokeWidth={1.5} />
            <span>Powered by Whisper</span>
          </div>
        }
      />

      <VoiceUploadClient />
    </>
  );
}
