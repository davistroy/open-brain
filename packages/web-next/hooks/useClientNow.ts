'use client';
import { useEffect, useState } from 'react';

/**
 * Returns Date.now() only after mount (null during SSR + first client render),
 * so relative-time / "is-today" logic never causes a hydration mismatch.
 *
 * Consumers must render a stable placeholder (absolute timestamp, dash, or the
 * unmodified content) while the value is null, then recompute once it is set —
 * this keeps the server render and the first client render byte-identical.
 */
export function useClientNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
  }, []);
  return now;
}
