import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { commitmentsApi } from '../lib/api-client';
import type { CommitmentStatus } from '../lib/types';

export function useCommitments(params: { status?: CommitmentStatus; limit?: number } = {}) {
  return useQuery({
    queryKey: ['commitments', params],
    queryFn: () => commitmentsApi.list(params),
  });
}

export function usePatchCommitment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { resolved?: boolean; status?: CommitmentStatus } }) =>
      commitmentsApi.patch(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['commitments'] });
    },
  });
}
