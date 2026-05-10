'use client'

const CAPTURE_TYPES = [
  'decision',
  'idea',
  'observation',
  'task',
  'win',
  'blocker',
  'question',
  'reflection',
] as const

interface TypePickerProps {
  selected: string
  onSelect: (type: string) => void
}

export function TypePicker({ selected, onSelect }: TypePickerProps) {
  return (
    <div className="flex flex-col gap-1 px-5 pb-5">
      {CAPTURE_TYPES.map((type) => (
        <button
          key={type}
          onClick={() => onSelect(type)}
          className={[
            'rounded-lg px-4 py-3 w-full text-left text-sm font-body capitalize transition-colors',
            selected === type
              ? 'border-2 border-book-cloth bg-book-cloth/10 text-slate-dark'
              : 'border border-cloud-medium text-slate-medium hover:bg-ivory-light',
          ].join(' ')}
        >
          {type.charAt(0).toUpperCase() + type.slice(1)}
        </button>
      ))}
    </div>
  )
}
