'use client'

import { Search } from 'lucide-react'

export function MobileEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12">
      <Search size={40} className="text-cloud-medium" />
      <span className="text-sm text-cloud-dark">Search your brain</span>
    </div>
  )
}
