import { ORIGIN } from './app';

// A fetch with the two things a browser adds by itself: a cookie jar and the Origin header.
export function cookieFetch(): typeof fetch {
  const jar = new Map<string, string>();
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('origin', ORIGIN);
    if (jar.size > 0) {
      headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    const res = await fetch(input, { ...init, headers });
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';');
      const [name = '', value = ''] = pair.split('=');
      const expired = attributes.some((a) =>
        a.trim().toLowerCase().startsWith('expires=thu, 01 jan 1970'),
      );
      if (expired || value === '') jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
}
