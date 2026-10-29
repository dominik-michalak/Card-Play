export type Config = {
  port: number;
  clientOrigin: string;
  isProduction: boolean;
  databaseUrl: string;
  jwtSecret: string;
  jwtRefreshSecret: string;
  bcryptCost: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  // how many reverse proxies sit in front of the server (0 = none); decides which address is
  // the client's when X-Forwarded-For is present
  trustProxy: number;
  // max register/login attempts per IP in 15 minutes
  authRateLimitMax: number;
  // tickets and replies a user may send per hour
  ticketCreateLimitPerHour: number;
  ticketReplyLimitPerHour: number;
};

const MIN_SECRET_LENGTH = 64;

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`missing required env variable: ${name}`);
  }
  return value;
}

function requireSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireEnv(env, name);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawPort = requireEnv(env, 'PORT');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PORT: ${rawPort}`);
  }

  const rawTrustProxy = env.TRUST_PROXY ?? '0';
  const trustProxy = Number(rawTrustProxy);
  if (!/^\d+$/.test(rawTrustProxy) || trustProxy > 10) {
    throw new Error(`invalid TRUST_PROXY: ${rawTrustProxy}`);
  }

  const jwtSecret = requireSecret(env, 'JWT_SECRET');
  const jwtRefreshSecret = requireSecret(env, 'JWT_REFRESH_SECRET');
  if (jwtSecret === jwtRefreshSecret) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be different');
  }

  return {
    port,
    clientOrigin: requireEnv(env, 'CLIENT_ORIGIN'),
    isProduction: env.NODE_ENV === 'production',
    databaseUrl: requireEnv(env, 'DATABASE_URL'),
    jwtSecret,
    jwtRefreshSecret,
    trustProxy,
    bcryptCost: 12,
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
    authRateLimitMax: 10,
    ticketCreateLimitPerHour: 5,
    ticketReplyLimitPerHour: 20,
  };
}
