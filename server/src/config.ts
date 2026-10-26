export type Config = {
  port: number;
  clientOrigin: string;
  isProduction: boolean;
};

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`missing required env variable: ${name}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawPort = requireEnv(env, 'PORT');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PORT: ${rawPort}`);
  }

  return {
    port,
    clientOrigin: requireEnv(env, 'CLIENT_ORIGIN'),
    isProduction: env.NODE_ENV === 'production',
  };
}
