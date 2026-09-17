#!/bin/sh
# Invoked by cron-backup.sh on the utility VM. No credentials are read by this shell.
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if /usr/bin/node "$ROOT/backup-all-recipes.js"; then
	if [ "${ANYLIST_RUN_CONVERSIONS:-0}" = "1" ]; then
		if ! /usr/bin/node "$ROOT/convert-snapshot.js" "$ROOT/exports/snapshots/latest-successful" --yaml --cooklang; then
			# Derived-format failure is recorded in the conversion manifest. The JSON
			# snapshot has already been validated and remains successful.
			/usr/bin/node "$ROOT/scripts/notify-failure.js" conversion 2>/dev/null || true
		fi
	fi
	exit 0
else
	status=$?
	/usr/bin/node "$ROOT/scripts/notify-failure.js" backup 2>/dev/null || true
	exit "$status"
fi
