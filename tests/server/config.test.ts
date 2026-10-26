import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/src/config';

const validEnv = {
  PORT: '3000',
  CLIENT_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://u:p@localhost:5434/db',
  JWT_SECRET: 'a'.repeat(64),
  JWT_REFRESH_SECRET: 'b'.repeat(64),
};

describe('loadConfig', () => {
  it('reads valid env', () => {
    expect(loadConfig(validEnv)).toMatchObject({
      port: 3000,
      clientOrigin: 'http://localhost:5173',
      isProduction: false,
      databaseUrl: validEnv.DATABASE_URL,
      bcryptCost: 12,
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 604800,
    });
  });

  it('flags production', () => {
    expect(loadConfig({ ...validEnv, NODE_ENV: 'production' }).isProduction).toBe(true);
  });

  it.each(['PORT', 'CLIENT_ORIGIN', 'DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET'])(
    'throws on missing %s',
    (name) => {
      const env: Record<string, string> = { ...validEnv };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(name);
    },
  );

  it.each(['abc', '0', '70000', '30.5'])('throws on invalid port %s', (port) => {
    expect(() => loadConfig({ ...validEnv, PORT: port })).toThrow('invalid PORT');
  });

  it('rejects short secrets', () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: 'short' })).toThrow('at least 64');
  });

  it('rejects identical secrets', () => {
    expect(() => loadConfig({ ...validEnv, JWT_REFRESH_SECRET: validEnv.JWT_SECRET })).toThrow(
      'must be different',
    );
  });
});
