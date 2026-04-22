import { useQuery } from '@tanstack/react-query';
import { searchApi } from '../lib/api-client';

export function useSearch(query: string, options: { limit?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['search', query, options.limit],
    queryFn: () => searchApi.search({ q: query, limit: options.limit }),
    enabled: (options.enabled ?? true) && query.length > 0,
  });
}
