import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Config } from './config';
import type { Db } from './db/client';
import { createErrorHandler, notFoundHandler } from './middleware/error-handler';
import { requireSameOrigin } from './middleware/require-same-origin';
import { createAuthRouter } from './modules/auth/auth.routes';
import { createAuthService } from './modules/auth/auth.service';
import { createRoomsRouter } from './modules/rooms/rooms.routes';
import type { RoomsService } from './modules/rooms/rooms.service';

// services with in-memory state are created once by the composition root and shared with the
// socket layer, so REST and Socket.IO always act on the same rooms
export type AppServices = { roomService: RoomsService };

export function createApp(config: Config, db: Db, services: AppServices): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '50kb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/v1', requireSameOrigin(config.clientOrigin));
  app.use('/api/v1/auth', createAuthRouter(createAuthService(db, config), config));
  app.use('/api/v1/lobbies', createRoomsRouter(services.roomService, config));

  app.use(notFoundHandler);
  app.use(createErrorHandler());
  return app;
}
