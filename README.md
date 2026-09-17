# AnyList read-only backup and offline conversion

This repository is prepared for a separate Linux utility VM. It does not install or modify cron, systemd, or any scheduled task on this development laptop.

`backup-all-recipes.js` uses `anylist@0.8.6` only for login and one user-data read. It never invokes create, save, update, or delete APIs. It writes a dated snapshot containing authoritative raw recipe JSON (`recipes/<stable-id>.json`), local photos, recipe collections, collection memberships, and a validation manifest. Credentials and authentication tokens are neither exported nor logged.

## Utility-VM deployment

The examples use `/opt/anylist-export` as the explicit deployment and working directory. Replace it consistently if your VM uses another location.

1. On the VM, install Node.js 22 or newer and `util-linux` (for `/usr/bin/flock`). Copy this repository to `/opt/anylist-export` and install locked dependencies:

   ```sh
   cd /opt/anylist-export
   /usr/bin/npm ci --ignore-scripts
   install -d -m 700 /opt/anylist-export/logs /opt/anylist-export/exports
   chmod 700 /opt/anylist-export/scripts/*.sh
   cp .env.example .env
   chmod 600 .env
   ```

2. Edit `/opt/anylist-export/.env` locally with `ANYLIST_EMAIL` and `ANYLIST_PASSWORD`. It is gitignored. Optionally configure `ANYLIST_FAILURE_WEBHOOK` for a minimal HTTPS failure event; no secret, recipe content, URL, or error body is included in the notification.

3. Perform a manual live-backup test on the VM before scheduling:

   ```sh
   cd /opt/anylist-export
   /usr/bin/node /opt/anylist-export/backup-all-recipes.js
   readlink /opt/anylist-export/exports/snapshots/latest-successful
   ```

   A backup returns nonzero for authentication, retrieval, photo, write, or validation failure. The dated snapshot is promoted only after validation. `latest-successful` is atomically changed only after that promotion, and prior snapshots are never replaced or deleted.

4. Review and install the example cron file on the VM only:

   ```sh
   crontab /opt/anylist-export/cron.example
   crontab -l
   ```

   It runs nightly at 02:30. `scripts/cron-backup.sh` uses `/usr/bin/flock -n -E 75` around the whole backup/conversion workflow, so an overlapping run exits 75. Cron uses explicit executable paths and changes to the repository working directory itself; it does not depend on an interactive shell environment.

5. Check status and logs on the VM:

   ```sh
   readlink /opt/anylist-export/exports/snapshots/latest-successful
   cat /opt/anylist-export/exports/snapshots/latest-successful/manifest.json
   tail -n 100 /opt/anylist-export/logs/backup.log
   grep CRON /var/log/syslog   # Debian/Ubuntu, if cron logging is enabled
   ```

Set `ANYLIST_RUN_CONVERSIONS=1` in the crontab (already shown in `cron.example`) to run both offline conversions after a successful backup. A derived-format failure is recorded under that snapshot’s `derived/manifest.json` and can notify through the optional hook, but cannot invalidate, delete, or change the completed JSON backup. Automatic snapshot deletion is deliberately not implemented.

## Offline conversion

Conversion never contacts AnyList and accepts only a completed snapshot:

```sh
cd /opt/anylist-export
/usr/bin/node /opt/anylist-export/convert-snapshot.js \
  /opt/anylist-export/exports/snapshots/latest-successful --yaml --cooklang
```

It creates `derived/yaml/recipes/<stable-id>.yaml`; every YAML file is parsed and compared with its original JSON so scalar types, nulls, arrays, and nested data must round-trip exactly. `derived/cooklang/recipes/<stable-id>.cook` is optional and is parsed using the official `@cooklang/cooklang` WASM parser. Conversion successes and per-recipe failures are tracked separately in `derived/manifest.json`.

Cooklang conversion uses YAML front matter for supported metadata; preserves sections from AnyList ingredient headings; renders quantities and units in Cooklang markers when safely parseable; and preserves multiline instructions using Cooklang’s continuation syntax. AnyList does not associate ingredients with individual instruction steps, so the converter writes an explicit `Ingredients (unlinked)` section and never invents associations. Every Cooklang file has a `.companion.json` with the source recipe path, local photo references, and fields that Cooklang cannot represent losslessly (including raw ingredient strings and identifiers, timestamps, nutritional info, photo URLs/IDs, and app-specific identifiers). The raw snapshot JSON remains authoritative.

Run local, offline-only verification with fixtures for fractions, ingredient sections, multiline notes, and missing optional fields:

```sh
npm run test:conversion
```

The repository’s existing completed snapshot was also converted and validated locally; no new live export was initiated for conversion testing.
