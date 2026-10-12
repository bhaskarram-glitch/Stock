#!/usr/bin/env bash
# infra/ops/install.sh — install/refresh the server's scheduled jobs, backups and alerts.
# Idempotent: re-run after any change under infra/ops (stock-deploy tells you when).
#   sudo bash /opt/stock/infra/ops/install.sh            # app user defaults to "ubuntu"
#   sudo STOCK_USER=pi bash /opt/stock/infra/ops/install.sh   # e.g. on a Raspberry Pi
#
# Installs: infra/ops/bin/* → /usr/local/bin, infra/ops/systemd/* → /etc/systemd/system,
# creates /etc/stock/stock.env (only if missing), /var/lib/stock and $BACKUP_DIR, enables all timers.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
STOCK_USER="${STOCK_USER:-ubuntu}"
id "$STOCK_USER" >/dev/null 2>&1 || { echo "user $STOCK_USER does not exist" >&2; exit 1; }
id -nG "$STOCK_USER" | tr ' ' '\n' | grep -qx docker || {
  echo "$STOCK_USER is not in the docker group (sudo usermod -aG docker $STOCK_USER)" >&2; exit 1; }
for cmd in docker flock curl; do
  command -v "$cmd" >/dev/null || { echo "missing command: $cmd" >&2; exit 1; }
done

here="$(cd "$(dirname "$0")" && pwd)"

install -m 0755 "$here"/bin/stock-* /usr/local/bin/

for unit in "$here"/systemd/*; do
  sed "s/__STOCK_USER__/$STOCK_USER/" "$unit" >"/etc/systemd/system/$(basename "$unit")"
  chmod 0644 "/etc/systemd/system/$(basename "$unit")"
done

install -d -o "$STOCK_USER" -g "$STOCK_USER" -m 0700 /etc/stock /var/lib/stock
if [ ! -e /etc/stock/stock.env ]; then
  install -o "$STOCK_USER" -g "$STOCK_USER" -m 0600 "$here/stock.env.example" /etc/stock/stock.env
  echo "created /etc/stock/stock.env — fill in Telegram (and later RCLONE_REMOTE)"
fi
# shellcheck disable=SC1091
BACKUP_DIR="$(. /etc/stock/stock.env; echo "${BACKUP_DIR:-/data/backups/daily}")"
install -d -o "$STOCK_USER" -g "$STOCK_USER" -m 0750 "$BACKUP_DIR"

systemctl daemon-reload
timers=()
for t in "$here"/systemd/*.timer; do timers+=("$(basename "$t")"); done
systemctl enable --now "${timers[@]}" >/dev/null
echo "enabled: ${timers[*]}"
systemctl list-timers 'stock-*' --no-pager
