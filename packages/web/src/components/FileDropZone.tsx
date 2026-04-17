/**
 * FileDropZone — reusable drag-and-drop file input.
 *
 * Wraps react-dropzone's `useDropzone` hook with shadcn-styled visuals
 * (idle, drag-over, disabled) and keyboard accessibility (visible focus ring).
 * Filters oversized files client-side before invoking the `onFiles` callback,
 * surfacing any rejections in a small list below the zone.
 *
 * Usage:
 *   <FileDropZone
 *     accept={{ 'text/csv': ['.csv'] }}
 *     maxSizeBytes={25 * 1024 * 1024}
 *     onFiles={(files) => uploadAll(files)}
 *   />
 */

import { useCallback, useMemo, useState } from 'react'
import { useDropzone, type Accept, type FileRejection } from 'react-dropzone'
import { Upload } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FileDropZoneProps {
  /** Called with the list of files that passed size + accept filters. */
  onFiles: (files: File[]) => void
  /** react-dropzone accept map, e.g. `{ 'text/csv': ['.csv'] }`. */
  accept?: Accept
  /** Maximum per-file size in bytes. Defaults to 25 MB. */
  maxSizeBytes?: number
  /** Allow multiple files (default true). */
  multiple?: boolean
  /** Disables drop + click interactions. */
  disabled?: boolean
  /** Extra Tailwind classes merged onto the outer drop zone. */
  className?: string
  /** Primary CTA text. */
  label?: string
  /** Secondary helper text under the label. */
  sublabel?: string
}

interface Rejection {
  name: string
  reason: string
}

const DEFAULT_MAX_SIZE = 25 * 1024 * 1024 // 25 MB
const DEFAULT_LABEL = 'Drop files here or click to browse'
const DEFAULT_SUBLABEL = 'Accepts CSV, HTML, PDF — up to 25 MB'

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function describeRejection(rejection: FileRejection, maxSize: number): Rejection {
  const firstCode = rejection.errors[0]?.code
  const firstMsg = rejection.errors[0]?.message ?? 'rejected'
  let reason = firstMsg
  if (firstCode === 'file-too-large') {
    reason = `exceeds ${formatBytes(maxSize)}`
  } else if (firstCode === 'file-invalid-type') {
    reason = 'unsupported file type'
  }
  return { name: rejection.file.name, reason }
}

export function FileDropZone({
  onFiles,
  accept,
  maxSizeBytes = DEFAULT_MAX_SIZE,
  multiple = true,
  disabled = false,
  className,
  label = DEFAULT_LABEL,
  sublabel = DEFAULT_SUBLABEL,
}: FileDropZoneProps) {
  const [rejections, setRejections] = useState<Rejection[]>([])

  const handleDrop = useCallback(
    (accepted: File[], fileRejections: FileRejection[]) => {
      const nextRejections = fileRejections.map((r) => describeRejection(r, maxSizeBytes))
      setRejections(nextRejections)
      if (accepted.length > 0) {
        onFiles(accepted)
      }
    },
    [maxSizeBytes, onFiles],
  )

  const { getRootProps, getInputProps, isDragActive, isFocused } = useDropzone({
    onDrop: handleDrop,
    accept,
    maxSize: maxSizeBytes,
    multiple,
    disabled,
  })

  const zoneClasses = useMemo(
    () =>
      cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-background px-6 py-10 text-center transition-colors',
        'cursor-pointer select-none',
        isFocused && 'ring-2 ring-ring ring-offset-2',
        isDragActive && !disabled && 'border-primary bg-accent text-accent-foreground',
        disabled && 'cursor-not-allowed opacity-60 bg-muted',
        className,
      ),
    [isFocused, isDragActive, disabled, className],
  )

  return (
    <div className="w-full">
      <div
        {...getRootProps({
          className: zoneClasses,
          role: 'button',
          'aria-label': label,
          'aria-disabled': disabled || undefined,
        })}
      >
        <input {...getInputProps()} />
        <Upload
          className={cn('h-8 w-8 text-muted-foreground', isDragActive && !disabled && 'text-primary')}
          aria-hidden="true"
        />
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{sublabel}</p>
      </div>

      {rejections.length > 0 && (
        <ul
          className="mt-2 space-y-1 text-xs text-destructive"
          role="alert"
          aria-live="polite"
          data-testid="file-drop-zone-rejections"
        >
          {rejections.map((r, idx) => (
            <li key={`${r.name}-${idx}`}>
              <span className="font-medium">{r.name}</span>
              <span className="text-muted-foreground"> — {r.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
