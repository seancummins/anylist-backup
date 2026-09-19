#!/bin/sh
# Invoked under the VM cron lock. Configuration is loaded by Node, not the shell.
set -eu
umask 077
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
exec /usr/bin/node "$ROOT/scripts/run-backup.js"
