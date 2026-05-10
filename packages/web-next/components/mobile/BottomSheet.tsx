'use client'

interface BottomSheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}

export function BottomSheet({ open, onClose, title, children }: BottomSheetProps) {
  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-dark/40 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet panel */}
      <div
        className="fixed bottom-0 inset-x-0 bg-white rounded-t-2xl z-50 max-h-[70dvh] overflow-y-auto"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Drag handle */}
        <div className="flex justify-center my-3">
          <div className="w-10 h-1 rounded-full bg-cloud-medium" />
        </div>

        {/* Title */}
        <div className="text-xs font-mono uppercase tracking-wider text-slate-light px-5 pb-3">
          {title}
        </div>

        {/* Content */}
        {children}
      </div>
    </>
  )
}
