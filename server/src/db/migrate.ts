import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { requireEnv } from '../config';
import { createDb, type Db } from './client';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function runMigrations(db: Db): Promise<void> {
  return migrate(db, { migrationsFolder });
}

// run as a script: `npm run db:migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { db, pool } = createDb(requireEnv(process.env, 'DATABASE_URL'));
  await runMigrations(db);
  await pool.end();
  console.log('migrations applied');
}
