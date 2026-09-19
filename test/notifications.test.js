'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {send, summary, mode} = require('../scripts/email');
const {run} = require('../scripts/run-backup');
const config = {ANYLIST_EMAIL_NOTIFICATIONS: 'enabled', BREVO_API_KEY: 'fake-key', BREVO_SENDER_EMAIL: 'sender@example.com', BREVO_SENDER_NAME: 'Backup', BREVO_RECIPIENT_EMAIL: 'recipient@example.com'};
const report = {hostname: 'fixture-host', startedAt: '2026-09-19T12:00:00Z', durationSeconds: '1.0', outcome: 'backup succeeded', backup: 'succeeded', yaml: 'complete', cooklang: 'complete', counts: {recipes: 3, downloadedPhotos: 2, photoReferences: 2}, snapshot: '/tmp/snapshot', errors: []};
const response = (status, headers = {}) => ({status, headers: new Headers(headers), body: {cancel: async () => {}}, json: () => {throw new Error('Do not read private response');}});

test('successful Brevo request uses official endpoint, key header and plain summary', async () => {
	let calls = 0;
	await send(config, report, {fetchImpl: async (url, options) => {
		calls++;
		assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
		assert.equal(options.headers['api-key'], 'fake-key');
		assert.equal(options.redirect, 'error');
		assert.ok(options.signal instanceof AbortSignal);
		const body = JSON.parse(options.body);
		assert.deepEqual(body.sender, {email: config.BREVO_SENDER_EMAIL, name: 'Backup'});
		assert.equal(body.textContent, summary(report));
		assert.match(body.textContent, /Photos: 2 downloaded \/ 2 referenced/);
		return response(201);
	}});
	assert.equal(calls, 1);
});

test('authentication rejection is sanitized and never retried', async () => {
	let calls = 0;
	await assert.rejects(send(config, report, {fetchImpl: async () => {calls++; return response(401);}}), /^Error: Brevo HTTP 401$/);
	assert.equal(calls, 1);
});

test('rate limiting respects bounded Retry-After; retries transient server errors', async () => {
	let calls = 0;
	const waits = [];
	await send(config, report, {fetchImpl: async () => response([429, 503, 201][calls++], {'retry-after': '2'}), sleep: async ms => waits.push(ms)});
	assert.equal(calls, 3);
	assert.deepEqual(waits, [2000, 2000]);
	await assert.rejects(send(config, report, {fetchImpl: async () => response(429, {'retry-after': '600'}), sleep: async () => assert.fail('long cooldown must not retry')}), /HTTP 429/);
});

test('timeouts and network errors stop after three attempts and suppress exception data', async () => {
	let calls = 0;
	await assert.rejects(send(config, report, {fetchImpl: async () => {calls++; throw new Error('secret https://private/photo?token=secret');}, sleep: async () => {}}), /^Error: Brevo network error or timeout \(delivery may be ambiguous\)$/);
	assert.equal(calls, 3);
});

const backup = async r => {r.snapshot = '/tmp/fixture'; r.counts = report.counts;};
test('disabled and default enabled policy; every-run sends exactly once', async () => {
	assert.equal(mode({}), 'disabled');
	assert.equal(mode(config), 'failures-only');
	for (const policy of ['disabled', 'enabled', 'failures-only', 'every-run']) {
		let calls = 0;
		assert.equal(await run({config: {...config, ANYLIST_EMAIL_NOTIFICATIONS: policy}, backup, send: async () => {calls++;}}), 0);
		assert.equal(calls, policy === 'every-run' ? 1 : 0);
	}
});

test('early startup and incomplete backup failures notify without exception contents', async () => {
	for (const phase of ['configuration', 'authentication', 'photo download']) {
		let calls = 0;
		const code = await run({config, backup: async r => {r.phase = phase; throw new Error('password secret recipe name https://private/photo');}, log: () => {}, send: async (_, r) => {
			calls++;
			assert.equal(r.outcome, 'backup failed');
			assert.match(summary(r), new RegExp(`${phase} failed`));
			assert.doesNotMatch(summary(r), /secret|recipe name|https:/);
		}});
		assert.equal(code, 1); assert.equal(calls, 1);
	}
});

test('conversion partial failure retains JSON success, separate statuses and exit code', async () => {
	let calls = 0;
	const code = await run({config: {...config, ANYLIST_RUN_CONVERSIONS: '1'}, backup,
		convert: async () => ({code: 2, manifest: {yaml: {status: 'complete'}, cooklang: {status: 'partial', failures: [{message: 'private recipe'}]}}}),
		log: () => {}, send: async (_, r) => {
			calls++; assert.equal(r.outcome, 'backup succeeded; conversion failed');
			assert.equal(r.backup, 'succeeded'); assert.equal(r.yaml, 'complete'); assert.equal(r.cooklang, 'partial');
			assert.doesNotMatch(summary(r), /private recipe/);
		}});
	assert.equal(code, 2); assert.equal(calls, 1);
});

test('notification failure preserves backup/conversion failure codes; alone returns 3', async () => {
	for (const failure of ['none', 'backup', 'conversion']) {
		const logs = [];
		const code = await run({config: {...config, ANYLIST_EMAIL_NOTIFICATIONS: 'every-run', ANYLIST_RUN_CONVERSIONS: '1'},
			backup: failure === 'backup' ? async () => {throw new Error('private');} : backup,
			convert: async () => ({code: failure === 'conversion' ? 2 : 0, manifest: {yaml: {status: 'complete'}, cooklang: {status: failure === 'conversion' ? 'partial' : 'complete'}}}),
			send: async () => {throw new Error('Brevo HTTP 401');}, log: message => logs.push(message)});
		assert.equal(code, {none: 3, backup: 1, conversion: 2}[failure]);
		assert.ok(logs.some(line => line === 'Email notification failed: Brevo HTTP 401'));
	}
});

test('explicit test email bypasses disabled policy and never exports', async () => {
	let calls = 0;
	assert.equal(await run({config: {...config, ANYLIST_EMAIL_NOTIFICATIONS: 'disabled'}, testEmail: true,
		backup: async () => assert.fail('must not export'), send: async (_, r) => {calls++; assert.match(r.outcome, /no export performed/);}}), 0);
	assert.equal(calls, 1);
});

test('fixture workflow converts offline and notification failure leaves latest-successful intact', async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anylist-notify-test-'));
	try {
		const snapshot = path.join(temporary, 'snapshot');
		await fs.mkdir(path.join(snapshot, 'recipes'), {recursive: true});
		const recipes = require('./fixtures/representative-recipes.json');
		for (const recipe of recipes) await fs.writeFile(path.join(snapshot, 'recipes', `${recipe.identifier}.json`), JSON.stringify(recipe));
		await fs.writeFile(path.join(snapshot, 'manifest.json'), JSON.stringify({status: 'complete', counts: {recipes: recipes.length}, photos: []}));
		const latest = path.join(temporary, 'latest-successful');
		const code = await run({config: {...config, ANYLIST_EMAIL_NOTIFICATIONS: 'every-run', ANYLIST_RUN_CONVERSIONS: '1'},
			backup: async r => {await fs.symlink('snapshot', latest); r.snapshot = snapshot;},
			send: async (_, r) => {assert.equal(r.yaml, 'complete'); assert.equal(r.cooklang, 'complete'); throw new Error('Brevo HTTP 401');}, log: () => {}});
		assert.equal(code, 3);
		assert.equal(await fs.readlink(latest), 'snapshot');
		assert.equal(JSON.parse(await fs.readFile(path.join(snapshot, 'manifest.json'))).status, 'complete');
	} finally {await fs.rm(temporary, {recursive: true, force: true});}
});

test('request timeout is ten seconds and abort is handled as a bounded failure', async t => {
	t.mock.method(AbortSignal, 'timeout', ms => {
		assert.equal(ms, 10000);
		return AbortSignal.abort(new DOMException('private timeout details', 'TimeoutError'));
	});
	let calls = 0;
	await assert.rejects(send(config, report, {fetchImpl: async (_, options) => {
		calls++; options.signal.throwIfAborted();
	}, sleep: async () => {}}), /network error or timeout/);
	assert.equal(calls, 3);
});

test('overlapping cron run exits normally without launching the workflow', async () => {
	const {spawnSync} = require('node:child_process');
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anylist-lock-test-'));
	try {
		await fs.mkdir(path.join(temporary, 'scripts'));
		await fs.mkdir(path.join(temporary, 'exports'));
		const script = path.join(temporary, 'scripts', 'cron-backup.sh');
		await fs.copyFile(path.join(__dirname, '..', 'scripts', 'cron-backup.sh'), script);
		// No run-backup-once.sh exists here: accidentally launching it would fail.
		const result = spawnSync('/usr/bin/flock', [path.join(temporary, 'exports', '.backup.lock'), '/bin/sh', script], {encoding: 'utf8'});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Backup skipped/);
	} finally {await fs.rm(temporary, {recursive: true, force: true});}
});
