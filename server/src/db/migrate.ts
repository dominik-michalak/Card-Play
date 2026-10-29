import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireEnv } from '../config';
import { createDb, type Db } from './client';

// The SQL files sit in server/drizzle. This file is src/db/migrate.ts in the source tree and
// dist/migrate.js in the bundle, so the folder is one or two levels up, depending on which.
export function resolveMigrationsFolder(
  here: URL = new URL(import.meta.url),
  exists: (path: string) => boolean = existsSync,
): string {
  const candidates = ['../../drizzle', '../drizzle'].map((path) =>
    fileURLToPath(new URL(path, here)),
  );
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) {
    throw new Error(`migrations folder not found, looked in: ${candidates.join(', ')}`);
  }
  return found;
}

export function runMigrations(db: Db): Promise<void> {
  return migrate(db, { migrationsFolder: resolveMigrationsFolder() });
}

// run as a script: `npm run db:migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { db, pool } = createDb(requireEnv(process.env, 'DATABASE_URL'));
  await runMigrations(db);
  await pool.end();
  console.log('migrations applied');
}
