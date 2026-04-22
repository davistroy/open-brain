import { HttpError, buildQueryString } from '../../src/lib/api-client';

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
