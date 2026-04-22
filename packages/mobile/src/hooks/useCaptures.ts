import { useQuery } from '@tanstack/react-query';
import { capturesApi } from '../lib/api-client';

type CapturesListParams = Parameters<typeof capturesApi.list>[0];

export function useCaptures(params: CapturesListParams = {}) {
  return useQuery({
    queryKey: ['captures', params],
    queryFn: () => capturesApi.list(params),
  });
}

export function useCapture(id: string | undefined) {
  return useQuery({
    queryKey: ['capture', id],
    queryFn: () => capturesApi.get(id!),
    enabled: !!id,
  });
}
