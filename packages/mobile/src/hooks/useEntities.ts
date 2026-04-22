import { useQuery } from '@tanstack/react-query';
import { entitiesApi } from '../lib/api-client';

export function useEntities(params: { limit?: number; offset?: number; type_filter?: string; sort_by?: string } = {}) {
  return useQuery({
    queryKey: ['entities', params],
    queryFn: () => entitiesApi.list(params),
  });
}

export function useEntity(id: string | undefined) {
  return useQuery({
    queryKey: ['entity', id],
    queryFn: () => entitiesApi.get(id!),
    enabled: !!id,
  });
}
