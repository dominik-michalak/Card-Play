// Checks a running stack from the outside, the way a browser would use it:
//   BASE_URL=http://localhost:8080 node scripts/smoke.mjs
// It registers a throw-away account, so run it against a stack you do not mind that in.
import { io } from 'socket.io-client';

const base = process.env.BASE_URL ?? `http://localhost:${process.env.APP_PORT ?? 8080}`;
const origin = process.env.PUBLIC_ORIGIN ?? base;
let failed = 0;

async function check(name, run) {
  try {
    await run();
    console.log(`ok    ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}: ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const unique = `smoke_${Date.now().toString(36)}`.slice(0, 20);
const credentials = {
  username: unique,
  email: `${unique}@example.com`,
  password: 'correct horse battery',
};
let accessToken;
let refreshCookie;

await check('the health endpoint answers through the proxy', async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status === 200, `status ${res.status}`);
  expect((await res.json()).status === 'ok', 'body is not {"status":"ok"}');
});

await check('the client page is served with its security headers', async () => {
  const res = await fetch(`${base}/`);
  expect(res.status === 200, `status ${res.status}`);
  expect((await res.text()).includes('<div id="root">'), 'no root element');
  expect(res.headers.get('x-content-type-options') === 'nosniff', 'missing nosniff');
  expect(res.headers.get('content-security-policy')?.includes("default-src 'self'"), 'missing CSP');
});

await check('an unknown page falls back to the client', async () => {
  const res = await fetch(`${base}/lobby/anything`);
  expect(res.status === 200 && (await res.text()).includes('<div id="root">'), 'no fallback');
});

await check('registering gives a session and a hardened refresh cookie', async () => {
  const res = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(credentials),
  });
  expect(res.status === 201, `status ${res.status}`);
  accessToken = (await res.json()).accessToken;
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
  expect(cookie, 'no refresh cookie');
  expect(/HttpOnly/i.test(cookie), 'cookie is readable by scripts');
  expect(/SameSite=Strict/i.test(cookie), 'cookie is not SameSite=Strict');
  expect(/Secure/i.test(cookie), 'cookie is not Secure in production mode');
  refreshCookie = cookie.split(';')[0];
});

await check('a state-changing request from another origin is refused', async () => {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  expect(res.status === 403, `status ${res.status}`);
});

await check('the API needs a token and accepts a valid one', async () => {
  const anonymous = await fetch(`${base}/api/v1/lobbies/current`);
  expect(anonymous.status === 401, `anonymous got ${anonymous.status}`);
  const member = await fetch(`${base}/api/v1/lobbies/current`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(member.status === 404, `member got ${member.status} (no room yet)`);
});

await check('the staff API is closed to an ordinary account', async () => {
  const res = await fetch(`${base}/api/v1/moderation/users`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(res.status === 403, `status ${res.status}`);
});

await check('the session can be renewed from the cookie', async () => {
  const res = await fetch(`${base}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { origin, cookie: refreshCookie },
  });
  expect(res.status === 200, `status ${res.status}`);
  accessToken = (await res.json()).accessToken;
});

await check(
  'a socket connects through the proxy and a room can be created and entered',
  async () => {
    const api = (path, body) =>
      fetch(`${base}/api/v1${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });
    const created = await api('/lobbies', { gameType: 'war', mode: 'bot' });
    expect(created.status === 201, `room: status ${created.status}`);
    const room = await created.json();

    const socket = io(base, {
      auth: { token: accessToken },
      transports: ['websocket'],
      forceNew: true,
    });
    try {
      const players = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no room:players within 5 s')), 5000);
        socket.on('connect_error', (e) => reject(new Error(`connect_error ${e.message}`)));
        socket.on('connect', () => socket.emit('room:join', { roomId: room.id }));
        socket.on('room:players', (payload) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });
      expect(players.players.length === 1, 'the bot room should list the host only');
      // a bot room starts by itself: wait for the first game state
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the game did not start')), 8000);
        socket.on('game:state_update', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      socket.close();
    }
  },
);

await check('a socket without a token is refused', async () => {
  const socket = io(base, { transports: ['websocket'], forceNew: true });
  try {
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer')), 5000);
      socket.on('connect', () => reject(new Error('connected without a token')));
      socket.on('connect_error', (e) => {
        clearTimeout(timer);
        resolve(e.message);
      });
    });
    expect(message === 'UNAUTHORIZED', `got ${message}`);
  } finally {
    socket.close();
  }
});

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
