'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {loadDotEnv} = require('./config');
const email = require('./email');
const ROOT = path.resolve(__dirname, '..');

async function convert(snapshot) {
	const result = spawnSync(process.execPath, [path.join(ROOT, 'convert-snapshot.js'), snapshot, '--yaml', '--cooklang'], {stdio: 'ignore'});
	let manifest;
	try { manifest = JSON.parse(await fs.readFile(path.join(snapshot, 'derived', 'manifest.json'), 'utf8')); } catch {}
	return {code: result.status ?? 1, manifest};
}

async function run(options = {}) {
	const start = Date.now();
	const report = {hostname: os.hostname(), startedAt: new Date(start).toISOString(), backup: 'not started',
		yaml: 'not requested', cooklang: 'not requested', errors: [], phase: 'startup'};
	let config = options.config || {...process.env};
	let code = 0;
	const log = options.log || console.error;
	try {
		if (!options.config) config = {...loadDotEnv(path.join(ROOT, '.env')), ...process.env};
		if (options.testEmail) {
			report.outcome = 'test email (no export performed)';
		} else {
			const conversions = config.ANYLIST_RUN_CONVERSIONS === '1';
			if (conversions) report.yaml = report.cooklang = 'not run (backup incomplete)';
			await (options.backup || require('../backup-all-recipes').main)(report);
			report.backup = 'succeeded';
			report.outcome = 'backup succeeded';
			if (conversions) {
				report.phase = 'conversion';
				report.yaml = report.cooklang = 'failed';
				const result = await (options.convert || convert)(report.snapshot);
				for (const format of ['yaml', 'cooklang']) {
					const status = result.manifest?.[format]?.status;
					report[format] = ['complete', 'partial', 'failed'].includes(status) ? status : 'failed';
				}
				code = result.code || (report.yaml !== 'complete' || report.cooklang !== 'complete' ? 2 : 0);
				if (code) throw new Error('conversion failed');
			}
		}
	} catch {
		code ||= 1;
		const conversionFailed = report.backup === 'succeeded';
		if (!conversionFailed) report.backup = 'failed/incomplete';
		report.outcome = conversionFailed ? 'backup succeeded; conversion failed' : 'backup failed';
		// Only controlled stage names; never send exception messages or manifest errors.
		const phases = ['startup', 'configuration', 'snapshot setup', 'authentication', 'recipe retrieval', 'JSON writing', 'photo download', 'validation', 'snapshot promotion', 'latest-successful update', 'conversion'];
		report.errors.push(`${phases.includes(report.phase) ? report.phase : 'backup'} failed; inspect private VM logs/manifests.`);
		log(report.errors[0]);
	}
	if (code && config.ANYLIST_FAILURE_WEBHOOK && !options.testEmail) {
		const hook = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'notify-failure.js'), report.backup === 'succeeded' ? 'conversion' : 'backup'], {stdio: 'ignore', timeout: 10000});
		if (hook.status !== 0) log('Legacy failure webhook failed.');
	}
	report.durationSeconds = ((Date.now() - start) / 1000).toFixed(1);
	try {
		const mode = email.mode(config);
		if (options.testEmail || mode === 'every-run' || (mode === 'failures-only' && code !== 0)) {
			await (options.send || email.send)(config, report);
		}
	} catch (error) {
		// email.send throws only fixed diagnostics, never response bodies or credentials.
		log(`Email notification failed: ${error.message}`);
		code ||= 3;
	}
	return code;
}

module.exports = {run};
if (require.main === module) run({testEmail: process.argv.includes('--test-email')}).then(code => { process.exitCode = code; });
