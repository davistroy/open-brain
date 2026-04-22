'use client';

/**
 * SearchInput — controlled search input with 300ms debounce.
 *
 * On each keystroke, debounces 300ms then pushes `?q=<value>` to the
 * URL (router.push, not replace, so back/forward work correctly).
 * Form submit fires immediately without waiting for debounce.
 *
 * Design: full-width, 38px height, Search icon left, X clear button right.
 * Matches Cloudscape search bar style.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';

interface SearchInputProps {
  /** Initial value from URL ?q= param (passed from RSC page). */
  initialQuery?: string;
  /** Debounce delay in ms (default 300). */
  debounceMs?: number;
}

export function SearchInput({ initialQuery = '', debounceMs = 300 }: SearchInputProps) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync with RSC-controlled URL param on navigation (back/forward)
  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  const pushQuery = useCallback(
    (q: string) => {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      const url = q.trim() ? `/search?${params.toString()}` : '/search';
      router.push(url);
    },
    [router],
  );

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setValue(q);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushQuery(q);
    }, debounceMs);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    pushQuery(value);
  }

  function handleClear() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setValue('');
    router.push('/search');
  }

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <form onSubmit={handleSubmit} role="search" aria-label="Search captures">
      <div className="relative flex items-center">
        {/* Search icon — left */}
        <Search
          className="absolute left-[12px] text-text-body-secondary pointer-events-none shrink-0"
          size={14}
          strokeWidth={1.5}
          aria-hidden
        />

        <input
          type="search"
          value={value}
          onChange={handleChange}
          placeholder="Search captures or ask a question..."
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-label="Search query"
          className={[
            'w-full h-[38px]',
            'bg-bg-container border border-cloud-medium rounded-none',
            'font-body text-[13.5px] font-light text-text-body',
            'pl-[36px]',
            value ? 'pr-[36px]' : 'pr-[12px]',
            'outline-none focus:border-slate-medium',
            'transition-[border-color] duration-[120ms]',
            'placeholder:text-text-body-secondary',
          ].join(' ')}
        />

        {/* Clear button — right, only when there is a value */}
        {value && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear search"
            className="absolute right-[10px] text-text-body-secondary hover:text-text-body transition-colors"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        )}
      </div>
    </form>
  );
}
