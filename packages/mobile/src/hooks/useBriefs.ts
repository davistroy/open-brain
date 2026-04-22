import { useQuery } from '@tanstack/react-query';
import { briefsApi } from '../lib/api-client';

export function useBriefs(params: { limit?: number; offset?: number; kind?: string } = {}) {
  return useQuery({
    queryKey: ['briefs', params],
    queryFn: () => briefsApi.list(params),
  });
}

export function useBrief(id: string | undefined) {
  return useQuery({
    queryKey: ['brief', id],
    queryFn: () => briefsApi.get(id!),
    enabled: !!id,
  });
}
