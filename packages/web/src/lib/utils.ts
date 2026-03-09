import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Utility for conditional class merging with Tailwind CSS
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Format a date string for display
 */
export function formatDate(isoDate: string): string {
  const date = new Date(isoDate)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/**
 * Format a date string with time
 */
export function formatDateTime(isoDate: string): string {
  const date = new Date(isoDate)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLen = 150): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '…'
}

/**
 * Get relative time (e.g., "2 hours ago")
 */
export function relativeTime(isoDate: string | Date): string {
  const date = new Date(isoDate)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)

  if (diffDay > 0) return `${diffDay}d ago`
  if (diffHr > 0) return `${diffHr}h ago`
  if (diffMin > 0) return `${diffMin}m ago`
  return 'just now'
}

/**
 * Capitalize first letter of string
 */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Convert snake_case or kebab-case to Title Case
 */
export function toTitleCase(str: string): string {
  return str
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Alias for relativeTime — used by CaptureCard, CaptureDetail
 */
export const formatRelativeTime = relativeTime
