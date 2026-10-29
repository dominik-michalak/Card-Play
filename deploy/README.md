# Running CardPlay outside development

This describes the local Docker stack and what to change before it faces the internet. It does not
deploy anything and does not set up certificates (no Certbot); it says where those steps go.

## The stack

`compose.app.yml` runs three containers in the project `cardplay-app`:

| Service    | Image                | What it does                                                                      |
| ---------- | -------------------- | --------------------------------------------------------------------------------- |
| `postgres` | `postgres:17-alpine` | the database, on a volume of its own, not published to the host                   |
| `server`   | `server/Dockerfile`  | Express and Socket.IO; applies the migrations, then starts                        |
| `client`   | `client/Dockerfile`  | nginx: serves the built client and forwards `/api/` and `/socket.io/` to `server` |

Every service has a healthcheck, and each one starts only after the previous one is healthy
(`postgres` → `server` → `client`).

```sh
cp .env.example .env     # fill in the secrets: openssl rand -hex 64 (twice, different values)
npm run app:up           # build and start, waits until everything is healthy
open http://localhost:8080
npm run app:down         # stop (the data stays in the volume)
```

The scripts use their own Compose project (`cardplay-app`), so they never touch the development
database of `docker-compose.yml` or any container you already have.

### Checking the whole stack

```sh
npm run app:test         # builds a throw-away stack, checks it, removes it with its volume
npm run app:smoke        # only the checks, against a stack that is already running
```

`scripts/smoke.mjs` talks to the stack the way a browser does: health, the client page and its
headers, registration and the refresh cookie flags, the origin check, access without and with a
token, the closed staff API, token renewal, a socket through the proxy and a bot game that starts.

## Configuration

| Variable                           | Meaning                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | at least 64 characters each, different from each other                                                                                                                       |
| `DATABASE_URL`                     | connection string; the compose file builds it from the `POSTGRES_*` variables                                                                                                |
| `PUBLIC_ORIGIN`                    | the address the browser opens, **exactly**, with the scheme and without a trailing slash. The server accepts state-changing requests only from this origin (`CLIENT_ORIGIN`) |
| `TRUST_PROXY`                      | how many reverse proxies stand in front of the server (see below)                                                                                                            |
| `NODE_ENV=production`              | turns on `Secure` for the refresh cookie                                                                                                                                     |

### `TRUST_PROXY`

Rate limits (login attempts, joining by code) are counted per client address. Behind a reverse
proxy every request arrives from the proxy, so without `TRUST_PROXY` the whole site would share
one limit; with it the server reads the address the proxy puts in `X-Forwarded-For`.

- `0` (default): no proxy. `X-Forwarded-For` is ignored, so a client cannot dodge a limit by
  inventing the header.
- `1`: one proxy in front (the `client` container in the compose stack, or your own reverse proxy
  if you terminate TLS in front of that container: then use `2`).
- Set it to the real number of hops. Too low and clients share limits; too high and a client can
  forge its address.

## HTTPS

The refresh token is a `Secure`, `HttpOnly`, `SameSite=Strict` cookie, so outside `localhost` the
site must be served over HTTPS or the browser will not keep the session.

1. Put a TLS-terminating reverse proxy in front of the `client` container (or publish no port
   from it and let the proxy reach it on the Docker network). `deploy/nginx.https.example.conf`
   is a starting point: it redirects HTTP to HTTPS, sets HSTS, forwards the WebSocket upgrade and
   passes `X-Forwarded-For` / `X-Forwarded-Proto`.
2. Obtain a certificate with whatever tool you use and point `ssl_certificate` /
   `ssl_certificate_key` at it. This repository does not issue or renew certificates.
3. Set `PUBLIC_ORIGIN=https://your.domain` (no trailing slash) and `TRUST_PROXY=2` (your proxy
   plus the `client` container).
4. Keep `127.0.0.1:` in the `ports:` line of the `client` service if the proxy runs on the same
   machine, so the plain-HTTP port is not reachable from outside.

## Operations notes

- **Migrations** run at every start of the `server` container (`node dist/db/migrate.js`); a
  failing migration stops the container instead of starting a server on a half-migrated database.
  They only add to the schema; none of them deletes data.
- **Restarts** cancel games in progress (they are marked `cancelled`, without Elo changes) and
  forget ready flags, queues and chat history, which live in the memory of one process. Run one
  instance of `server`.
- **Backups**: the data is the `app_postgres_data` volume. For example
  `docker compose -p cardplay-app -f compose.app.yml exec postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB > backup.sql`.
- **Logs**: `docker compose -p cardplay-app -f compose.app.yml logs -f server`.
- **Accounts with roles**: the first admin has to be made in the database
  (`update users set role = 'admin' where username = '...'`); after that admins manage roles and
  bans in the application.
