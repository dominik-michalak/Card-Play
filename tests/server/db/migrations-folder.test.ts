import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveMigrationsFolder } from '../../../server/src/db/migrate';

const at = (path: string) => fileURLToPath(new URL(path, 'file:///app/server/'));

describe('resolveMigrationsFolder', () => {
  it('finds the folder next to src when running from the source tree', () => {
    // file: /app/server/src/db/migrate.ts -> /app/server/drizzle
    const folder = resolveMigrationsFolder(
      new URL('file:///app/server/src/db/migrate.ts'),
      (path) => path === at('drizzle'),
    );
    expect(folder).toBe(at('drizzle'));
  });

  it('finds the folder next to dist when running the built bundle', () => {
    // file: /app/server/dist/migrate.js -> /app/server/drizzle
    const folder = resolveMigrationsFolder(
      new URL('file:///app/server/dist/migrate.js'),
      (path) => path === at('drizzle'),
    );
    expect(folder).toBe(at('drizzle'));
  });

  it('says what is missing instead of failing later inside the migrator', () => {
    expect(() =>
      resolveMigrationsFolder(new URL('file:///app/server/dist/migrate.js'), () => false),
    ).toThrow('migrations folder not found');
  });

  it('finds the real folder of this repository', () => {
    expect(resolveMigrationsFolder()).toMatch(/server\/drizzle$/);
  });
});
