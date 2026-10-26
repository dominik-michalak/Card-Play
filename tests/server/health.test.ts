import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startTestApp } from '../helpers/app';

describe('GET /health', () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;

  beforeAll(async () => {
    app = await startTestApp();
  });
  afterAll(() => app.close());

  it('returns ok', async () => {
    const res = await api(app.url, '/health', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('does not expose the framework header', async () => {
    const res = await api(app.url, '/health', { method: 'GET' });
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('sets security headers', async () => {
    const res = await api(app.url, '/health', { method: 'GET' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await api(app.url, '/nope', { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'route not found' } });
  });

  it('never allows a foreign origin through CORS', async () => {
    const allowed = await api(app.url, '/health', {
      method: 'GET',
      origin: 'http://localhost:5173',
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

    const other = await api(app.url, '/health', { method: 'GET', origin: 'http://evil.example' });
    // the header always names our own origin, so a browser on another site is refused
    expect(other.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
