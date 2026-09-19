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

   It runs nightly at 02:30. `scripts/cron-backup.sh` uses `/usr/bin/flock -n -E 75` around the whole backup/conversion workflow, so an overlapping run is logged as a normal skip and exits 0 without email. Cron uses explicit executable paths and changes to the repository working directory itself; it does not depend on an interactive shell environment.

5. Check status and logs on the VM:

   ```sh
   readlink /opt/anylist-export/exports/snapshots/latest-successful
   cat /opt/anylist-export/exports/snapshots/latest-successful/manifest.json
   tail -n 100 /opt/anylist-export/logs/backup.log
   grep CRON /var/log/syslog   # Debian/Ubuntu, if cron logging is enabled
   ```

Set `ANYLIST_RUN_CONVERSIONS=1` in the crontab (already shown in `cron.example`) to run both offline conversions after a successful backup. A derived-format failure is recorded under that snapshot’s `derived/manifest.json` and can notify through email or the optional hook, but cannot invalidate, delete, or change the completed JSON backup. Automatic snapshot deletion is deliberately not implemented.

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
npm run test:notifications
```

The repository’s existing completed snapshot was also converted and validated locally; no new live export was initiated for conversion testing.

## Optional Brevo email on the VM

This uses Brevo's official [transactional-email endpoint](https://developers.brevo.com/reference/send-transac-email), `POST https://api.brevo.com/v3/smtp/email`, with [API-key authentication](https://developers.brevo.com/docs/api-key-authentication). Use a Brevo API key, not an SMTP key; no separate “Brevosend” command or integration is assumed. There are no additional dependencies.

On the utility VM, edit the gitignored `/opt/anylist-export/.env` (keep mode 600). Set `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`, and `BREVO_RECIPIENT_EMAIL` using the placeholders in `.env.example`. Verify the sender/domain in Brevo. Never put credentials in command arguments, cron entries, source control, or shared logs. Environment variables take precedence over `.env`.

Set `ANYLIST_EMAIL_NOTIFICATIONS` to:

- `disabled` (default): no automatic email.
- `enabled` or `failures-only`: email on failed/incomplete backups or failed requested conversions.
- `every-run`: email after every attempted backup, successful or failed. Lock skips do not send mail.

Both `npm run backup:recipes` and the cron wrapper use the same coordinator. `ANYLIST_RUN_CONVERSIONS=1` requests YAML and Cooklang after a successful backup; it can be configured in `.env` or the VM cron environment. Standalone offline conversion and single-recipe export commands do not send notifications.

One summary includes hostname, UTC start time, elapsed time before email delivery, overall outcome, recipe inventory count, downloaded/referenced photo counts, snapshot path, and separate JSON/YAML/Cooklang statuses. Counts unavailable during early startup are shown as unknown; recipe count on failure is the retrieved inventory, not a claim that all files were written. Errors identify the failed stage only. No recipe contents, identifiers, exception text, response bodies, credentials, or photo URLs are sent. Inspect private snapshot manifests for deeper diagnosis. A conversion failure explicitly says “backup succeeded; conversion failed.”

To send an explicit test email on the VM, without contacting AnyList or exporting anything:

```sh
cd /opt/anylist-export
/usr/bin/npm run email:test
```

This explicit command sends even when automatic notifications are disabled. No test email is sent by the offline test suite. It was not sent during development.

Delivery uses a 10-second timeout per request, at most three attempts, and short bounded delays (at most five seconds). Network errors, timeouts, HTTP 408/429 and 5xx responses can be retried; authentication and other permanent errors are not retried. A `Retry-After` longer than five seconds ends delivery attempts rather than retrying prematurely. **Ambiguous network/delivery failures may cause duplicate mail when retried.** HTTP 201 means Brevo accepted the message; it does not guarantee inbox delivery.

Email runs after snapshot promotion, the normal `latest-successful` update, and requested conversions. It cannot delete or invalidate a successful backup. Exit codes are 0 for success/normal lock skip, 1 for backup/startup failure (or conversion process failure), 2 for incomplete conversion, and 3 when only notification configuration/delivery fails. An existing backup/conversion failure code takes precedence over an email failure. Conversion failure codes are now propagated by the cron wrapper instead of being swallowed. The legacy optional failure webhook remains supported independently, with a ten-second process limit; it does not receive email summaries.

Troubleshooting:

- `Email notification failed: Brevo HTTP 401/403`: check the VM API key, account access, and Brevo IP restrictions. Do not paste the key into logs or chat.
- HTTP 400: check sender verification and the configured sender/recipient addresses. HTTP 429: check limits and Brevo activity before manually retrying.
- Network error/timeout: check VM DNS and outbound HTTPS access to `api.brevo.com`; check Brevo transactional logs before retrying because delivery may already have happened.
- Accepted but missing mail: check Brevo transactional logs, recipient address, suppression/bounce status, and spam folder.
- Missing configuration or invalid mode: correct `.env` and permissions, then run the explicit test command. A notification problem is logged clearly without response bodies or credentials.

The coordinator covers missing AnyList credentials, dependency loading, authentication, snapshot setup/write/validation, and conversion failures once Node starts. If `.env` cannot be read, delivery is only possible if the required notification settings are already in the environment. It cannot report a VM outage, cron never launching, a missing/broken Node runtime, shell/lock setup failures before Node starts, or a forcibly terminated process. Use external monitoring for those cases.

Offline verification mocks every email request (success, authentication rejection, rate limiting, transient failures, timeouts, and summary/exit policies), and uses the existing recipe fixtures for real offline conversion. No AnyList or Brevo connection is made by these tests.
