'use strict';

// Read-only proof of concept. Deliberately calls no AnyList save/delete/create APIs.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const AnyList = require('anylist');

const ROOT = __dirname;
const OUTPUT_DIR = path.join(ROOT, 'exports');

function loadDotEnv(file) {
	try {
		return require('node:fs').readFileSync(file, 'utf8').split(/\r?\n/).reduce((values, line) => {
			const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
			if (!match || match[2].startsWith('#')) return values;
			let value = match[2];
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
			values[match[1]] = value;
			return values;
		}, {});
	} catch (error) {
		if (error.code === 'ENOENT') return {};
		throw error;
	}
}

function setting(dotEnv, name) {
	return process.env[name] || dotEnv[name];
}

function plain(value) {
	if (value === null || typeof value !== 'object') return value;
	if (Buffer.isBuffer(value)) return {encoding: 'base64', data: value.toString('base64')};
	if (Array.isArray(value)) return value.map(plain);
	if (typeof value.toJSON === 'function') return plain(value.toJSON());
	return Object.fromEntries(Object.entries(value)
		.filter(([key]) => !key.startsWith('_'))
		.map(([key, item]) => [key, plain(item)]));
}

function extension(contentType, photoUrl) {
	const type = (contentType || '').split(';', 1)[0].toLowerCase();
	const byType = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif'};
	if (byType[type]) return byType[type];
	try {
		const candidate = path.extname(new URL(photoUrl).pathname).toLowerCase();
		if (/^\.(?:jpe?g|png|gif|webp|heic|heif)$/.test(candidate)) return candidate === '.jpeg' ? '.jpg' : candidate;
	} catch {}
	return '.img';
}

function recognizedImage(buffer) {
	return (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
		(buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
		(buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) ||
		(buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') ||
		(buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1'].includes(buffer.subarray(8, 12).toString('ascii')));
}

function safeFilename(value) {
	return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function main() {
	const dotEnv = loadDotEnv(path.join(ROOT, '.env'));
	const email = setting(dotEnv, 'ANYLIST_EMAIL');
	const password = setting(dotEnv, 'ANYLIST_PASSWORD');
	const wantedId = setting(dotEnv, 'ANYLIST_RECIPE_ID');
	if (!email || !password) throw new Error('Missing ANYLIST_EMAIL or ANYLIST_PASSWORD. Set environment variables or create .env from .env.example.');

	// `false` avoids the listener WebSocket. `null` prevents token/client-ID files.
	const any = new AnyList({email, password, credentialsFile: null});
	try {
		await any.login(false);
		const recipes = await any.getRecipes(); // Only POST: data/user-data/get
		const inventory = recipes.map(recipe => ({
			id: recipe.identifier,
			name: recipe.name || null,
			photoUrlCount: recipe.photoUrls.length,
			photoIdCount: recipe.photoIds.length,
		})).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
		await fs.mkdir(OUTPUT_DIR, {recursive: true});
		await fs.writeFile(path.join(OUTPUT_DIR, 'recipe-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);

		const selected = wantedId ? recipes.find(recipe => recipe.identifier === wantedId) : recipes.find(recipe => recipe.photoUrls.length > 0 || recipe.photoIds.length > 0);
		if (!selected) throw new Error(wantedId ? 'ANYLIST_RECIPE_ID was not found in the retrieved inventory.' : 'No recipe in the inventory has an associated photo ID or URL.');
		if (selected.photoUrls.length === 0 && selected.photoIds.length === 0) throw new Error('Selected recipe has no associated photo ID or URL.');

		const rawRecipe = any._userData.recipeDataResponse.recipes.find(recipe => recipe.identifier === selected.identifier);
		const exported = plain(rawRecipe);
		const stem = safeFilename(selected.identifier);
		const jsonName = `${stem}.json`;
		await fs.writeFile(path.join(OUTPUT_DIR, jsonName), `${JSON.stringify(exported, null, 2)}\n`);

		// The Node client exposes photo IDs but does not implement this read. The
		// companion AnyList protocol implementation documents their public CDN form.
		const photoUrl = selected.photoUrls[0] || `https://photos.anylist.com/${encodeURIComponent(selected.photoIds[0])}.jpg`;
		const response = await fetch(photoUrl, {redirect: 'error'});
		if (!response.ok) throw new Error(`Photo download returned HTTP ${response.status}. JSON was written, but no photo is retained.`);
		const photo = Buffer.from(await response.arrayBuffer());
		if (!recognizedImage(photo)) throw new Error('Downloaded photo does not have a recognized offline image signature. JSON was written, but no photo is retained.');
		const photoName = `${stem}${extension(response.headers.get('content-type'), photoUrl)}`;
		await fs.writeFile(path.join(OUTPUT_DIR, photoName), photo);

		const manifest = {
			exportedAt: new Date().toISOString(),
			recipeId: selected.identifier,
			recipeName: selected.name || null,
			inventoryFile: 'recipe-inventory.json',
			recipeJson: {file: jsonName, sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(OUTPUT_DIR, jsonName))).digest('hex')},
			photo: {file: photoName, bytes: photo.length, contentType: response.headers.get('content-type') || null, sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(OUTPUT_DIR, photoName))).digest('hex')},
			limitations: ['Only the first associated photo is downloaded.', 'When photoUrls are absent, the photo is resolved from the first photoId using AnyList’s public JPEG CDN convention.', 'The client’s documented Recipe wrapper omits the protobuf icon and recipeDataId fields; this export serializes the raw decoded recipe to retain available fields.'],
		};
		await fs.writeFile(path.join(OUTPUT_DIR, `${stem}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);

		// Offline verification: parse JSON, hash bytes as recorded, and inspect image magic bytes.
		JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, jsonName), 'utf8'));
		const savedPhoto = await fs.readFile(path.join(OUTPUT_DIR, photoName));
		if (!recognizedImage(savedPhoto) || savedPhoto.length !== manifest.photo.bytes || crypto.createHash('sha256').update(savedPhoto).digest('hex') !== manifest.photo.sha256) throw new Error('Offline verification failed.');
		console.log(`Exported 1 of ${inventory.length} recipes to exports/${jsonName} and exports/${photoName}; offline verification passed.`);
	} finally {
		any.teardown();
	}
}

main().catch(error => {
	console.error(`Export failed: ${error.message}`);
	process.exitCode = 1;
});
