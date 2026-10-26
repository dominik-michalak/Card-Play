import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';

const config = loadConfig();
const { db } = createDb(config.databaseUrl);

createApp(config, db).listen(config.port, () => {
  console.log(`server listening on port ${config.port}`);
});
