'use strict';

function mode(config) {
	const value = config.ANYLIST_EMAIL_NOTIFICATIONS || 'disabled';
	if (['disabled', 'failures-only', 'every-run'].includes(value)) return value;
	if (value === 'enabled') return 'failures-only';
	throw new Error('Invalid ANYLIST_EMAIL_NOTIFICATIONS (use disabled, enabled, failures-only, every-run).');
}

function summary(report) {
	return [
		`Host: ${report.hostname}`, `Started: ${report.startedAt}`,
		`Duration: ${report.durationSeconds}s`, `Outcome: ${report.outcome}`,
		`Recipes: ${report.counts?.recipes ?? 'unknown'}`,
		`Photos: ${report.counts?.downloadedPhotos ?? 'unknown'} downloaded / ${report.counts?.photoReferences ?? 'unknown'} referenced`,
		`Snapshot: ${report.snapshot || 'not created'}`, `JSON backup: ${report.backup}`,
		`YAML: ${report.yaml}`, `Cooklang: ${report.cooklang}`,
		...report.errors.map(error => `Error: ${error}`),
	].join('\n');
}

async function send(config, report, {fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
	for (const key of ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_SENDER_NAME', 'BREVO_RECIPIENT_EMAIL']) {
		if (!config[key]?.trim()) throw new Error(`Missing ${key}.`);
	}
	const textContent = summary(report);
	const htmlContent = '<html><body><pre>' + textContent.replace(/[&<>"]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[char])) + '</pre></body></html>';
	const body = JSON.stringify({sender: {email: config.BREVO_SENDER_EMAIL, name: config.BREVO_SENDER_NAME},
		to: [{email: config.BREVO_RECIPIENT_EMAIL}], subject: `AnyList: ${report.outcome}`, textContent, htmlContent});
	for (let attempt = 0; attempt < 3; attempt++) {
		let failure;
		let retry = false;
		let delay = 1000 * (attempt + 1);
		try {
			const response = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
				method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
				headers: {'api-key': config.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json'}, body,
			});
			// Never read or log response bodies, even for failures.
			if (response.body) await response.body.cancel();
			if (response.status === 201) return;
			failure = `Brevo HTTP ${response.status}`;
			retry = response.status === 429 || response.status === 408 || response.status >= 500;
			const retryAfter = response.headers.get('retry-after');
			if (retryAfter) {
				const seconds = Number(retryAfter);
				const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
				// Do not wait indefinitely or retry earlier than a long server cooldown.
				if (wait > 5000) retry = false;
				else if (wait > 0) delay = Math.max(delay, wait);
			}
		} catch {
			failure = 'Brevo network error or timeout (delivery may be ambiguous)';
			retry = true;
		}
		if (!retry || attempt === 2) throw new Error(failure);
		await sleep(delay);
	}
}

module.exports = {mode, summary, send};
