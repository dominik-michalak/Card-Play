import { createServer } from 'node:http';
import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createResultsService } from './modules/results/results.service';
import { createRoomsService } from './modules/rooms/rooms.service';
import { createSocketServer } from './realtime/socket-server';

async function main(): Promise<void> {
  const config = loadConfig();
  const { db } = createDb(config.databaseUrl);
  const roomService = createRoomsService(db);
  const results = createResultsService(db);

  // no runner holds the games of the previous run and they are not resumed: they are marked
  // cancelled (rows are kept, nothing is deleted)
  const cancelled = await results.cancelUnfinishedGames();
  console.log(`${cancelled} unfinished games from the previous run marked as cancelled`);

  const server = createServer(createApp(config, db, { roomService }));
  createSocketServer(server, { config, roomService, results });
  server.listen(config.port, () => {
    console.log(`server listening on port ${config.port}`);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
