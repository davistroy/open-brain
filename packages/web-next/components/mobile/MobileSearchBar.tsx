'use client'

import { useState, useRef, useEffect } from 'react'
import { Search, X } from 'lucide-react'

interface MobileSearchBarProps {
  query: string
  onQueryChange: (q: string) => void
}

export function MobileSearchBar({ query, onQueryChange }: MobileSearchBarProps) {
  const [localValue, setLocalValue] = useState(query)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync if parent changes query externally
  useEffect(() => {
    setLocalValue(query)
  }, [query])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setLocalValue(value)

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      onQueryChange(value)
      const url = new URL(window.location.href)
      if (value.trim()) {
        url.searchParams.set('q', value)
      } else {
        url.searchParams.delete('q')
      }
      window.history.replaceState({}, '', url.toString())
    }, 300)
  }

  function handleClear() {
    setLocalValue('')
    onQueryChange('')
    const url = new URL(window.location.href)
    url.searchParams.delete('q')
    window.history.replaceState({}, '', url.toString())
  }

  return (
    <div className="relative flex items-center h-11 w-full">
      <Search
        size={18}
        className="absolute left-3 text-cloud-dark pointer-events-none"
      />
      <input
        type="text"
        value={localValue}
        onChange={handleChange}
        placeholder="Search or ask a question…"
        className="h-11 w-full pl-9 pr-9 border border-cloud-medium rounded-lg text-sm font-body bg-white focus:outline-none focus:ring-2 focus:ring-book-cloth focus:border-book-cloth transition-colors"
      />
      {localValue && (
        <button
          onClick={handleClear}
          className="absolute right-3 text-cloud-dark hover:text-slate-medium transition-colors"
          aria-label="Clear search"
        >
          <X size={18} />
        </button>
      )}
    </div>
  )
}
