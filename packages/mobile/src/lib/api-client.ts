import { config } from './config';
import { storage } from './storage';
import type {
  Capture, Entity, EntityDetail, Brief, BriefDetail,
  SearchResult, BoardCommitment, ListEnvelope, BrainView, CaptureType,
  CommitmentStatus,
} from './types';

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly path: string;

  constructor(status: number, body: unknown, path: string) {
    super(`HTTP ${status} on ${path}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

/**
 * Thrown when the API token is absent from SecureStore (device not yet
 * onboarded). UI code catches this to show the Settings → API Token flow.
 */
export class NotOnboardedError extends Error {
  constructor() {
    super('API token not provisioned. Go to Settings → API Token to configure.');
    this.name = 'NotOnboardedError';
  }
}

// ---------------------------------------------------------------------------
// Module-level token cache — avoids a SecureStore round-trip per request.
// SecureStore reads are cheap on iOS but serialized; caching prevents latency
// accumulation on screens that fire multiple parallel queries.
// Call clearTokenCache() after setApiToken() or deleteApiToken() so the next
// request picks up the new value.
// ---------------------------------------------------------------------------
let _cachedToken: string | null | undefined = undefined; // undefined = not yet read

export function clearTokenCache(): void {
  _cachedToken = undefined;
}

async function getToken(): Promise<string | null> {
  if (_cachedToken !== undefined) return _cachedToken;
  _cachedToken = await storage.getApiToken();
  return _cachedToken;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();

  if (token === null) {
    throw new NotOnboardedError();
  }

  const url = `${config.apiBaseUrl}${path}`;

  const headers: Record<string, string> = {
    'X-Open-Brain-Caller': 'mobile-app',
    'Authorization': `Bearer ${token}`,
    ...(init.headers as Record<string, string> | undefined),
  };

  if (init.body !== undefined && init.body !== null && typeof init.body === 'string') {
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const response = await fetch(url, { ...init, headers });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
    throw new HttpError(response.status, body, path);
  }

  if (response.status === 204) return undefined as unknown as T;
  return response.json() as Promise<T>;
}

export function buildQueryString(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) qs.append(key, String(item));
      }
    } else {
      qs.set(key, String(value));
    }
  }
  const str = qs.toString();
  return str ? `?${str}` : '';
}

export const capturesApi = {
  list: (params: { limit?: number; offset?: number; brain_view?: BrainView; capture_type?: CaptureType } = {}): Promise<ListEnvelope<Capture>> => {
    return request<ListEnvelope<Capture>>(`/captures${buildQueryString(params)}`);
  },
  get: (id: string): Promise<Capture> => {
    return request<Capture>(`/captures/${encodeURIComponent(id)}`);
  },
  create: (payload: { content: string; capture_type: CaptureType; brain_view: BrainView; source?: string }): Promise<{ id: string; pipeline_status: string; created_at: string }> => {
    return request('/captures', { method: 'POST', body: JSON.stringify(payload) });
  },
};

export const entitiesApi = {
  list: (params: { limit?: number; offset?: number; type_filter?: string; sort_by?: string } = {}): Promise<ListEnvelope<Entity>> => {
    return request<ListEnvelope<Entity>>(`/entities${buildQueryString(params)}`);
  },
  get: (id: string): Promise<EntityDetail> => {
    return request<EntityDetail>(`/entities/${encodeURIComponent(id)}`);
  },
};

export const briefsApi = {
  list: (params: { limit?: number; offset?: number; kind?: string } = {}): Promise<ListEnvelope<Brief>> => {
    return request<ListEnvelope<Brief>>(`/briefs${buildQueryString(params)}`);
  },
  get: (id: string): Promise<{ brief: Record<string, unknown> }> => {
    return request<{ brief: Record<string, unknown> }>(`/briefs/${encodeURIComponent(id)}`);
  },
  patchRead: (id: string, read: boolean): Promise<void> => {
    return request<void>(`/briefs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ read }) });
  },
};

export const searchApi = {
  search: (params: { q: string; limit?: number; include_related?: boolean }): Promise<{ results: SearchResult[]; total: number; query: string }> => {
    return request(`/search${buildQueryString(params)}`);
  },
};

export const commitmentsApi = {
  list: (params: { status?: CommitmentStatus; limit?: number; offset?: number } = {}): Promise<ListEnvelope<BoardCommitment>> => {
    return request<ListEnvelope<BoardCommitment>>(`/commitments${buildQueryString(params)}`);
  },
  patch: (id: string, body: { resolved?: boolean; status?: CommitmentStatus }): Promise<BoardCommitment> => {
    return request<BoardCommitment>(`/commitments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  },
};

export const settingsApi = {
  get: (key: string): Promise<{ key: string; value: unknown; updated_at: string | null }> => {
    return request(`/settings/${encodeURIComponent(key)}`);
  },
};

export const statsApi = {
  get: (): Promise<{ total_captures: number; by_type: Record<string, number>; by_view: Record<string, number> }> => {
    return request('/stats');
  },
};
