import { HttpError, NotOnboardedError, buildQueryString, request, clearTokenCache } from '../../src/lib/api-client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock expo-secure-store so tests don't touch iOS Keychain.
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

// Mock config so tests get a stable base URL.
jest.mock('../../src/lib/config', () => ({
  config: { apiBaseUrl: 'https://test.local/api/v1' },
}));

// Global fetch mock (use globalThis — works in both browser and Node env).
const mockFetch = jest.fn();
(globalThis as Record<string, unknown>)['fetch'] = mockFetch;

// Grab the mocked SecureStore module so individual tests can set return values.
import * as SecureStore from 'expo-secure-store';
const mockGetItemAsync = SecureStore.getItemAsync as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Existing tests (preserved)
// ---------------------------------------------------------------------------

describe('HttpError', () => {
  test('captures status, body, and path', () => {
    const err = new HttpError(404, { error: 'Not found' }, '/captures/123');
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ error: 'Not found' });
    expect(err.path).toBe('/captures/123');
    expect(err.message).toBe('HTTP 404 on /captures/123');
  });
});

describe('buildQueryString', () => {
  test('builds from params, skipping undefined', () => {
    const qs = buildQueryString({ limit: 20, offset: undefined, brain_view: 'career' });
    expect(qs).toBe('?limit=20&brain_view=career');
  });

  test('returns empty string for empty params', () => {
    expect(buildQueryString({})).toBe('');
  });

  test('handles arrays as repeated keys', () => {
    const qs = buildQueryString({ tags: ['a', 'b'] });
    expect(qs).toContain('tags=a');
    expect(qs).toContain('tags=b');
  });
});

// ---------------------------------------------------------------------------
// Token-attach behavior
// ---------------------------------------------------------------------------

describe('request — Bearer token attach', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearTokenCache();
  });

  test('throws NotOnboardedError when token is absent from SecureStore', async () => {
    mockGetItemAsync.mockResolvedValue(null);

    await expect(request('/captures')).rejects.toBeInstanceOf(NotOnboardedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('NotOnboardedError has descriptive name and message', () => {
    const err = new NotOnboardedError();
    expect(err.name).toBe('NotOnboardedError');
    expect(err.message).toMatch(/Settings/);
  });

  test('attaches Authorization: Bearer header when token is present', async () => {
    const token = 'a'.repeat(64);
    mockGetItemAsync.mockResolvedValue(token);
    mockFetch.mockResolvedValue(makeJsonResponse({ items: [] }));

    await request('/captures');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test.local/api/v1/captures');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${token}`);
    expect(headers['X-Open-Brain-Caller']).toBe('mobile-app');
  });

  test('caches token in module state — SecureStore called only once across multiple requests', async () => {
    const token = 'b'.repeat(64);
    mockGetItemAsync.mockResolvedValue(token);
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    await request('/captures');
    await request('/entities');
    await request('/search?q=test');

    // Three fetch calls, but only one SecureStore read.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockGetItemAsync).toHaveBeenCalledTimes(1);
  });

  test('clearTokenCache forces a fresh SecureStore read on next request', async () => {
    const token = 'c'.repeat(64);
    mockGetItemAsync.mockResolvedValue(token);
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    await request('/captures');
    expect(mockGetItemAsync).toHaveBeenCalledTimes(1);

    clearTokenCache();

    await request('/captures');
    expect(mockGetItemAsync).toHaveBeenCalledTimes(2);
  });

  test('caller-supplied headers do not override Authorization or X-Open-Brain-Caller', async () => {
    const token = 'd'.repeat(64);
    mockGetItemAsync.mockResolvedValue(token);
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    // A caller that tries to override the caller header (simulates a misconfigured caller).
    await request('/captures', {
      headers: { 'X-Custom': 'yes' },
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${token}`);
    expect(headers['X-Open-Brain-Caller']).toBe('mobile-app');
    expect(headers['X-Custom']).toBe('yes');
  });

  test('throws HttpError on non-ok response', async () => {
    const token = 'e'.repeat(64);
    mockGetItemAsync.mockResolvedValue(token);
    mockFetch.mockResolvedValue(makeJsonResponse({ error: 'Unauthorized', code: 'AUTH_INVALID' }, 401));

    await expect(request('/captures')).rejects.toMatchObject({
      status: 401,
      path: '/captures',
    });
  });

  test('returns undefined for 204 No Content', async () => {
    const token = 'f'.repeat(64);
    mockGetItemAsync.mockResolvedValue(token);
    mockFetch.mockResolvedValue({ ok: true, status: 204, json: jest.fn(), text: jest.fn() } as unknown as Response);

    const result = await request('/captures/x');
    expect(result).toBeUndefined();
  });
});
