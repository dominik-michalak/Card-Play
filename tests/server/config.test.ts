import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/src/config';

const validEnv = { PORT: '3000', CLIENT_ORIGIN: 'http://localhost:5173' };

describe('loadConfig', () => {
  it('reads valid env', () => {
    expect(loadConfig(validEnv)).toEqual({
      port: 3000,
      clientOrigin: 'http://localhost:5173',
      isProduction: false,
    });
  });

  it('flags production', () => {
    expect(loadConfig({ ...validEnv, NODE_ENV: 'production' }).isProduction).toBe(true);
  });

  it('throws on missing variable', () => {
    expect(() => loadConfig({ PORT: '3000' })).toThrow('CLIENT_ORIGIN');
  });

  it.each(['abc', '0', '70000', '30.5'])('throws on invalid port %s', (port) => {
    expect(() => loadConfig({ ...validEnv, PORT: port })).toThrow('invalid PORT');
  });
});
