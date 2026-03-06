import { useState, useRef } from 'react';
import { Upload, Mic, CheckCircle, AlertCircle, FileAudio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import type { BrainView } from '@/lib/types';

// Voice-capture service is on port 3001, proxied via VITE_VOICE_CAPTURE_URL or default
const VOICE_URL = import.meta.env.VITE_VOICE_CAPTURE_URL ?? 'http://localhost:3001';

const BRAIN_VIEWS: BrainView[] = ['career', 'personal', 'technical', 'work-internal', 'client'];

interface CaptureResult {
  id?: string;
  transcript?: string;
  capture_type?: string;
  brain_view?: string;
  duration_s?: number;
  language?: string;
  message?: string;
}

const ACCEPTED_TYPES = '.m4a,.wav,.mp3,.aac,.ogg,.webm';
const ACCEPTED_MIME = ['audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/webm', 'audio/aac'];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Voice() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [brainView, setBrainView] = useState<BrainView>('personal');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  function selectFile(file: File | null) {
    if (!file) return;
    if (!ACCEPTED_MIME.includes(file.type) && !file.name.match(/\.(m4a|wav|mp3|aac|ogg|webm)$/i)) {
      setError('Unsupported file type. Please use m4a, wav, or mp3.');
      return;
    }
    setSelectedFile(file);
    setError(null);
    setResult(null);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    selectFile(e.target.files?.[0] ?? null);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    selectFile(e.dataTransfer.files?.[0] ?? null);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedFile) return;

    setUploading(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append('audio', selectedFile);
      formData.append('brain_view', brainView);

      const res = await fetch(`${VOICE_URL}/api/capture`, {
        method: 'POST',
        body: formData,
        // No Content-Type header — browser sets multipart boundary automatically
      });

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Upload failed (${res.status}): ${text}`);
      }

      const data = (await res.json()) as CaptureResult;
      setResult(data);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function handleReset() {
    setSelectedFile(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div className="space-y-6 max-w-xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Voice Capture</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Upload an audio file to transcribe and capture into your brain.
        </p>
      </div>

      {/* Success result */}
      {result && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 space-y-3">
          <div className="flex items-center gap-2 text-green-800 font-medium text-sm">
            <CheckCircle className="h-4 w-4" />
            Captured successfully
          </div>
          {result.transcript && (
            <div>
              <h4 className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-1">Transcript</h4>
              <p className="text-sm text-green-900 leading-relaxed">{result.transcript}</p>
            </div>
          )}
          {(result.capture_type || result.brain_view || result.duration_s) && (
            <div className="flex gap-4 text-xs text-green-700">
              {result.capture_type && <span>Type: <span className="font-medium capitalize">{result.capture_type}</span></span>}
              {result.brain_view && <span>View: <span className="font-medium">{result.brain_view}</span></span>}
              {result.duration_s && <span>Duration: <span className="font-medium">{result.duration_s.toFixed(1)}s</span></span>}
              {result.language && <span>Language: <span className="font-medium">{result.language}</span></span>}
            </div>
          )}
          <Button size="sm" variant="outline" onClick={handleReset} className="border-green-300 text-green-800 hover:bg-green-100">
            Capture another
          </Button>
        </div>
      )}

      {!result && (
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Drop zone */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 cursor-pointer transition-colors ${
              dragOver
                ? 'border-primary bg-primary/5'
                : selectedFile
                  ? 'border-green-400 bg-green-50'
                  : 'border-muted-foreground/30 hover:border-primary/50 hover:bg-accent/30'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES}
              className="hidden"
              onChange={handleFileChange}
              aria-label="Select audio file"
            />

            {selectedFile ? (
              <>
                <FileAudio className="h-10 w-10 text-green-600 mb-3" />
                <p className="font-medium text-sm">{selectedFile.name}</p>
                <p className="text-xs text-muted-foreground mt-1">{formatFileSize(selectedFile.size)}</p>
              </>
            ) : (
              <>
                <Mic className="h-10 w-10 text-muted-foreground/50 mb-3" />
                <p className="text-sm font-medium">Drop audio here or click to browse</p>
                <p className="text-xs text-muted-foreground mt-1">m4a, wav, mp3 — from Voice Memos, Watch, or any recorder</p>
              </>
            )}
          </div>

          {/* Brain view selector */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Brain View</label>
            <div className="flex flex-wrap gap-2">
              {BRAIN_VIEWS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setBrainView(v)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors capitalize ${
                    brainView === v
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-muted-foreground/30 hover:border-primary/50 hover:bg-accent'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <Separator />

          {/* Submit */}
          <Button
            type="submit"
            disabled={!selectedFile || uploading}
            className="gap-2"
          >
            <Upload className="h-4 w-4" />
            {uploading ? 'Uploading & transcribing...' : 'Upload & Capture'}
          </Button>

          {uploading && (
            <p className="text-xs text-muted-foreground">
              Transcribing via faster-whisper — this may take 10–30 seconds depending on audio length.
            </p>
          )}
        </form>
      )}

      {/* Info footer */}
      <div className="rounded-lg border bg-secondary/50 px-4 py-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground text-sm">How it works</p>
        <p>Audio is sent to the voice-capture service on your homeserver, transcribed by faster-whisper, classified by the LLM, and ingested into the brain pipeline.</p>
        <p className="mt-1">For hands-free capture, use the iOS Shortcut on your iPhone or Watch — it submits directly to the same endpoint.</p>
      </div>
    </div>
  );
}
