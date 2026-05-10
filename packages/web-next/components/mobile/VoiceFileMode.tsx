'use client'

import { useRef, useState } from 'react'
import { FileAudio, FileAudio2, X, ChevronDown, Loader2 } from 'lucide-react'
import { useVoiceCapture } from '@/lib/api/voice-captures.hooks'
import type { BrainView } from '@/lib/types'

type UploadState = 'empty' | 'selected' | 'uploading'

interface VoiceFileModeProps {
  brainView: string
  onOpenViewPicker: () => void
  onCaptured: () => void
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  return `${(bytes / 1024).toFixed(1)} KB`
}

function truncateFilename(name: string, max = 25): string {
  if (name.length <= max) return name
  const ext = name.includes('.') ? '.' + name.split('.').pop() : ''
  const base = name.slice(0, max - ext.length - 3)
  return `${base}...${ext}`
}

export function VoiceFileMode({ brainView, onOpenViewPicker, onCaptured }: VoiceFileModeProps) {
  const [uploadState, setUploadState] = useState<UploadState>('empty')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { mutate } = useVoiceCapture()

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setSelectedFile(file)
    setUploadState('selected')
    // Reset input so same file can be re-selected after removal
    e.target.value = ''
  }

  function handleRemove() {
    setSelectedFile(null)
    setUploadState('empty')
  }

  function handleUpload() {
    if (!selectedFile || uploadState === 'uploading') return
    setUploadState('uploading')
    mutate(
      {
        file: selectedFile,
        opts: { brain_view: brainView as BrainView, device: 'mobile-web' },
      },
      {
        onSuccess: () => {
          setSelectedFile(null)
          setUploadState('empty')
          onCaptured()
        },
        onError: () => {
          setUploadState('selected')
        },
      }
    )
  }

  if (uploadState === 'empty') {
    return (
      <div className="flex flex-col gap-3">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={handleFileChange}
        />

        {/* Drop zone tap target */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-cloud-medium rounded-lg p-8 text-center flex flex-col items-center gap-2 w-full hover:border-book-cloth hover:bg-ivory-light transition-colors"
        >
          <FileAudio2 size={40} className="text-cloud-dark" />
          <span className="text-sm font-body text-cloud-dark">Tap to select audio file</span>
        </button>
      </div>
    )
  }

  const isUploading = uploadState === 'uploading'

  return (
    <div className="flex flex-col gap-3">
      {/* File info card */}
      <div className="border border-cloud-medium rounded-lg p-3 flex items-center gap-3 bg-white">
        <FileAudio size={20} className="text-slate-light flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-body text-slate-dark truncate">
            {selectedFile ? truncateFilename(selectedFile.name) : ''}
          </p>
          <p className="text-[10px] font-mono text-cloud-dark">
            {selectedFile ? formatFileSize(selectedFile.size) : ''}
          </p>
        </div>
        {!isUploading && (
          <button
            onClick={handleRemove}
            className="flex-shrink-0 p-1 text-cloud-dark hover:text-slate-medium transition-colors"
            aria-label="Remove file"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Brain view pill */}
      <button
        onClick={onOpenViewPicker}
        disabled={isUploading}
        className="self-start border border-cloud-medium rounded-full px-3 py-1.5 text-xs font-mono uppercase flex items-center gap-1 text-slate-medium hover:bg-ivory-light transition-colors disabled:opacity-40"
      >
        {brainView.replace(/-/g, ' ')}
        <ChevronDown size={14} />
      </button>

      {/* Upload button */}
      <button
        onClick={handleUpload}
        disabled={isUploading}
        className="w-full h-10 bg-book-cloth text-white rounded-lg text-sm font-body font-medium disabled:opacity-40 flex items-center justify-center gap-2 transition-opacity"
      >
        {isUploading ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Uploading…
          </>
        ) : (
          'Send'
        )}
      </button>
    </div>
  )
}
