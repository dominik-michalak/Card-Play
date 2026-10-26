import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/src/app';

describe('GET /health', () => {
  let baseUrl: string;
  let close: () => void;

  beforeAll(async () => {
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });

  afterAll(() => close());

  it('returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('does not expose the framework header', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
