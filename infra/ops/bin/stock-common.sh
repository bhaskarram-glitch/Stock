#!/usr/bin/env bash
# infra/ops/bin/stock-common.sh — sourced by the other stock-* scripts (installed to /usr/local/bin).
# Loads /etc/stock/stock.env and defines shared helpers. Not meant to be run directly.

STOCK_CONF="${STOCK_CONF:-/etc/stock/stock.env}"
if [ -r "$STOCK_CONF" ]; then
  # shellcheck disable=SC1090
  . "$STOCK_CONF"
fi

STOCK_DIR="${STOCK_DIR:-/opt/stock}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups/daily}"
STOCK_STATE_DIR="${STOCK_STATE_DIR:-/var/lib/stock}"
PG_CONTAINER="${PG_CONTAINER:-stock-pg}"
# shellcheck disable=SC2034  # used by the scripts that source this file
COMPOSE_FILE="$STOCK_DIR/infra/docker/docker-compose.yml"

# psql as the superuser inside the DB container (local socket, no password).
pg_sql() {
  docker exec "$PG_CONTAINER" psql -U postgres -d "${2:-stock}" -v ON_ERROR_STOP=1 -Atqc "$1"
}

# Newest local backup file, or empty.
latest_backup() {
  { find "$BACKUP_DIR" -maxdepth 1 -name 'stock_*.dump' -type f -printf '%T@ %p\n' 2>/dev/null || true; } |
    sort -nr | head -n 1 | cut -d' ' -f2-
}
