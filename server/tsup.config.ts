import { defineConfig } from 'tsup';

export default defineConfig({
  // the migration script is built too, so the container can apply migrations without tsx
  entry: ['src/index.ts', 'src/db/migrate.ts'],
  format: 'esm',
  target: 'node22',
  clean: true,
  noExternal: ['@cardplay/shared'],
});
