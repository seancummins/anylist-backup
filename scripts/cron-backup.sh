#!/bin/sh
# Cron entry point. flock holds the lock until run-backup-once.sh exits.
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$ROOT/exports"
if /usr/bin/flock -n -E 75 "$ROOT/exports/.backup.lock" "$ROOT/scripts/run-backup-once.sh"; then
    exit 0
else
    status=$?
    if [ "$status" = 75 ]; then
        echo "Backup skipped: another run holds the lock."
        exit 0
    fi
    exit "$status"
fi
