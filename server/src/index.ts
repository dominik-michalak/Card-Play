import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createRoomsService } from './modules/rooms/rooms.service';

const config = loadConfig();
const { db } = createDb(config.databaseUrl);

const roomService = createRoomsService(db);

createApp(config, db, { roomService }).listen(config.port, () => {
  console.log(`server listening on port ${config.port}`);
});
