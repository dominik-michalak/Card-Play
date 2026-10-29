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
import { authenticate } from './middleware/authenticate';
import { requireActiveUser } from './middleware/require-role';
import { createAdminRouter, createModerationRouter } from './modules/moderation/moderation.routes';
import type { BanEvents } from './modules/moderation/ban-events';
import { createModerationService } from './modules/moderation/moderation.service';
import { createFriendsRouter } from './modules/friends/friends.routes';
import type { FriendsService } from './modules/friends/friends.service';
import { createStaffTicketsRouter, createTicketsRouter } from './modules/tickets/tickets.routes';
import { createTicketsService } from './modules/tickets/tickets.service';
import { createProfileRouter } from './modules/profile/profile.routes';
import { createProfileService } from './modules/profile/profile.service';
import { createRoomsRouter } from './modules/rooms/rooms.routes';
import type { RoomsService } from './modules/rooms/rooms.service';

// services with in-memory state are created once by the composition root and shared with the
// socket layer, so REST and Socket.IO always act on the same rooms
export type AppServices = {
  roomService: RoomsService;
  friendsService: FriendsService;
  banEvents: BanEvents;
};

export function createApp(config: Config, db: Db, services: AppServices): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // without a trusted proxy the client's address is the socket's, and X-Forwarded-For is ignored
  app.set('trust proxy', config.trustProxy);

  app.use(helmet());
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '50kb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/v1', requireSameOrigin(config.clientOrigin));
  app.use('/api/v1/auth', createAuthRouter(createAuthService(db, config), config));

  // Everything below the sign-in routes needs an account that exists and is not banned. The
  // database says so on every request, so a ban takes effect at once and no route can forget it.
  const signedIn = [authenticate(config.jwtSecret), requireActiveUser(db)];
  app.use('/api/v1', ...signedIn);
  const moderation = createModerationService(db, services.banEvents);
  app.use('/api/v1/lobbies', createRoomsRouter(services.roomService, config));
  app.use('/api/v1/users/me/friends', createFriendsRouter(services.friendsService, config));
  const ticketsService = createTicketsService(db);
  app.use('/api/v1/tickets', createTicketsRouter(ticketsService, config));
  app.use(
    '/api/v1/staff/tickets',
    createStaffTicketsRouter(ticketsService, moderation, db, config),
  );
  app.use('/api/v1/moderation', createModerationRouter(moderation, db, config));
  app.use('/api/v1/admin', createAdminRouter(moderation, db, config));
  app.use('/api/v1', createProfileRouter(createProfileService(db), config));

  app.use(notFoundHandler);
  app.use(createErrorHandler());
  return app;
}
