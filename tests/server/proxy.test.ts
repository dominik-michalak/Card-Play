import { afterEach, describe, expect, it } from 'vitest';
import { api, startTestApp } from '../helpers/app';

type TestApp = Awaited<ReturnType<typeof startTestApp>>;
let app: TestApp | undefined;
afterEach(() => app?.close());

// failed logins count towards the limit per client address
const failedLogin = (url: string, forwardedFor: string) =>
  api(url, '/api/v1/auth/login', {
    body: { email: 'nobody@example.com', password: 'wrong' },
    headers: { 'x-forwarded-for': forwardedFor },
  });

describe('behind a reverse proxy', () => {
  it('tells clients apart by the forwarded address when one proxy is trusted', async () => {
    app = await startTestApp({ trustProxy: 1, authRateLimitMax: 2 });

    expect((await failedLogin(app.url, '203.0.113.1')).status).toBe(401);
    expect((await failedLogin(app.url, '203.0.113.1')).status).toBe(401);
    expect((await failedLogin(app.url, '203.0.113.1')).status).toBe(429);
    // a different visitor behind the same proxy is not locked out
    expect((await failedLogin(app.url, '203.0.113.2')).status).toBe(401);
  });

  it('ignores a forwarded address nobody vouches for', async () => {
    app = await startTestApp({ trustProxy: 0, authRateLimitMax: 2 });

    // one real client changing the header cannot get round the limit
    expect((await failedLogin(app.url, '203.0.113.1')).status).toBe(401);
    expect((await failedLogin(app.url, '203.0.113.2')).status).toBe(401);
    expect((await failedLogin(app.url, '203.0.113.3')).status).toBe(429);
  });
});
