'use client'

const BRAIN_VIEWS = [
  'career',
  'personal',
  'technical',
  'work-internal',
  'client',
] as const

function formatViewLabel(view: string): string {
  return view
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

interface ViewPickerProps {
  selected: string
  onSelect: (view: string) => void
}

export function ViewPicker({ selected, onSelect }: ViewPickerProps) {
  return (
    <div className="flex flex-col gap-1 px-5 pb-5">
      {BRAIN_VIEWS.map((view) => (
        <button
          key={view}
          onClick={() => onSelect(view)}
          className={[
            'rounded-lg px-4 py-3 w-full text-left text-sm font-body transition-colors',
            selected === view
              ? 'border-2 border-book-cloth bg-book-cloth/10 text-slate-dark'
              : 'border border-cloud-medium text-slate-medium hover:bg-ivory-light',
          ].join(' ')}
        >
          {formatViewLabel(view)}
        </button>
      ))}
    </div>
  )
}
