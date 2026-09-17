'use strict';

// Optional best-effort notification. Deliberately sends no credential, token,
// error body, recipe title, or source URL.
const fs = require('node:fs');
const path = require('node:path');

function loadDotEnv(file) {
	try {
		return fs.readFileSync(file, 'utf8').split(/\r?\n/).reduce((values, line) => {
			const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
			if (!match || match[2].startsWith('#')) return values;
			let value = match[2];
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
			values[match[1]] = value;
			return values;
		}, {});
	} catch { return {}; }
}

async function main() {
	const event = process.argv[2] || 'unknown';
	const settings = loadDotEnv(path.join(__dirname, '..', '.env'));
	const webhook = process.env.ANYLIST_FAILURE_WEBHOOK || settings.ANYLIST_FAILURE_WEBHOOK;
	if (!webhook) return;
	const response = await fetch(webhook, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({service: 'anylist-backup', event, occurredAt: new Date().toISOString()})});
	if (!response.ok) process.exitCode = 1;
}

main().catch(() => { process.exitCode = 1; });
