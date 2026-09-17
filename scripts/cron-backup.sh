#!/bin/sh
# Cron entry point. flock holds the lock until run-backup-once.sh exits.
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$ROOT/exports"
exec /usr/bin/flock -n -E 75 "$ROOT/exports/.backup.lock" "$ROOT/scripts/run-backup-once.sh"
