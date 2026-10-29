#!/bin/sh
# Builds the whole stack in a project of its own, checks it from the outside, and removes it
# again, volume included. Nothing of the development setup is touched.
set -u

PROJECT=cardplay-smoke
FILE=compose.app.yml

# secrets come from .env when it exists; this run needs no real ones
if [ -f .env ]; then set -a; . ./.env; set +a; fi
export POSTGRES_USER=${POSTGRES_USER:-cardplay}
export POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-smoke_password}
export POSTGRES_DB=${POSTGRES_DB:-cardplay}
export JWT_SECRET=${JWT_SECRET:-$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')}
export JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')x}
# set after .env, which has a PORT of its own for the development server
SMOKE_PORT=${SMOKE_PORT:-18080}
export APP_PORT=$SMOKE_PORT
export PUBLIC_ORIGIN=http://localhost:$SMOKE_PORT

cleanup() { docker compose -p "$PROJECT" -f "$FILE" down -v --rmi local --remove-orphans >/dev/null 2>&1; }
trap cleanup EXIT

docker compose -p "$PROJECT" -f "$FILE" up -d --build --wait || {
  docker compose -p "$PROJECT" -f "$FILE" logs --tail 40
  exit 1
}
docker compose -p "$PROJECT" -f "$FILE" ps
BASE_URL=http://localhost:$SMOKE_PORT node scripts/smoke.mjs
