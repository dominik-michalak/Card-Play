import { Client } from 'pg';
import { createDb } from '../../server/src/db/client';
import { runMigrations } from '../../server/src/db/migrate';

// derives a separate `<name>_test` database from DATABASE_URL so tests never touch dev data
export function testDatabaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.pathname = `${url.pathname}_test`;
  return url.toString();
}

export default async function setup(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // .env is optional, DATABASE_URL may come from the environment
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run the database tests (see .env.example)');
  }

  const testUrl = new URL(testDatabaseUrl());
  const testDbName = testUrl.pathname.slice(1);

  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const exists = await admin.query('select 1 from pg_database where datname = $1', [testDbName]);
  if (exists.rowCount === 0) {
    // identifiers cannot be bound as parameters; the name comes from our own env
    await admin.query(`create database "${testDbName.replaceAll('"', '')}"`);
  }
  await admin.end();

  const { db, pool } = createDb(testUrl.toString());
  await runMigrations(db);
  await pool.end();

  process.env.TEST_DATABASE_URL = testUrl.toString();
}
