'use strict';

// Read-only AnyList recipe backup. It intentionally invokes no create/save/update/delete API.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const AnyList = require('anylist');

const ROOT = __dirname;
const SNAPSHOTS = path.join(ROOT, 'exports', 'snapshots');

function loadDotEnv(file) {
	try {
		return fsSync.readFileSync(file, 'utf8').split(/\r?\n/).reduce((values, line) => {
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
	return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')).map(([key, item]) => [key, plain(item)]));
}

function sha256(data) {
	return crypto.createHash('sha256').update(data).digest('hex');
}

function recognizedImage(buffer) {
	return (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
		(buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
		(buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) ||
		(buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP');
}

function extension(contentType, photoUrl) {
	const mime = (contentType || '').split(';', 1)[0].toLowerCase();
	const byMime = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp'};
	if (byMime[mime]) return byMime[mime];
	try {
		const candidate = path.extname(new URL(photoUrl).pathname).toLowerCase();
		if (/^\.(?:jpe?g|png|gif|webp)$/.test(candidate)) return candidate === '.jpeg' ? '.jpg' : candidate;
	} catch {}
	return '.img';
}

function snapshotName() {
	return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function writeJson(directory, name, value) {
	const data = `${JSON.stringify(value, null, 2)}\n`;
	await fs.writeFile(path.join(directory, name), data);
	return {file: name, bytes: Buffer.byteLength(data), sha256: sha256(data)};
}

function collectionMemberships(recipeData, recipeIds) {
	const collections = [];
	if (recipeData.allRecipesCollection) collections.push({kind: 'all-recipes', collection: recipeData.allRecipesCollection});
	for (const collection of recipeData.recipeCollections || []) collections.push({kind: 'collection', collection});
	return collections.map(({kind, collection}) => ({
		kind,
		collectionId: collection.identifier,
		recipeIds: collection.recipeIds || [],
		missingRecipeIds: (collection.recipeIds || []).filter(id => !recipeIds.has(id)),
	}));
}

function photoReferences(recipe) {
	const references = [];
	for (const photoId of recipe.photoIds || []) references.push({key: `id-${photoId}`, source: 'photoId', photoId, url: `https://photos.anylist.com/${encodeURIComponent(photoId)}.jpg`});
	for (const url of recipe.photoUrls || []) references.push({key: `url-${sha256(url).slice(0, 16)}`, source: 'photoUrl', url});
	return [...new Map(references.map(reference => [reference.key, reference])).values()];
}

async function downloadPhoto(snapshot, recipeId, reference, ordinal) {
	const response = await fetch(reference.url, {redirect: 'error'});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (!recognizedImage(bytes)) throw new Error('unrecognized image signature');
	const relativeFile = path.join('photos', `${recipeId}-${ordinal}${extension(response.headers.get('content-type'), reference.url)}`);
	await fs.writeFile(path.join(snapshot, relativeFile), bytes);
	return {recipeId, source: reference.source, photoId: reference.photoId || null, file: relativeFile, bytes: bytes.length, contentType: response.headers.get('content-type') || null, sha256: sha256(bytes)};
}

async function validateSnapshot(snapshot, manifest) {
	const recipeDir = path.join(snapshot, 'recipes');
	const recipeFiles = await fs.readdir(recipeDir);
	if (recipeFiles.length !== manifest.counts.recipes) throw new Error('recipe file count differs from manifest');
	for (const file of recipeFiles) {
		const recipe = JSON.parse(await fs.readFile(path.join(recipeDir, file), 'utf8'));
		if (!recipe.identifier || file !== `${recipe.identifier}.json`) throw new Error(`recipe ID validation failed for ${file}`);
	}
	const memberships = JSON.parse(await fs.readFile(path.join(snapshot, 'collection-memberships.json'), 'utf8'));
	if (memberships.length !== manifest.counts.collections) throw new Error('collection count differs from manifest');
	for (const membership of memberships) {
		if (!membership.collectionId || !Array.isArray(membership.recipeIds) || !Array.isArray(membership.missingRecipeIds)) throw new Error('collection membership validation failed');
	}
	for (const photo of manifest.photos) {
		const bytes = await fs.readFile(path.join(snapshot, photo.file));
		if (!recognizedImage(bytes) || bytes.length !== photo.bytes || sha256(bytes) !== photo.sha256) throw new Error(`photo validation failed for ${photo.file}`);
	}
}

async function updateLatestSuccessful(snapshotName) {
	const temporaryLink = path.join(SNAPSHOTS, `.latest-successful-${process.pid}`);
	const latestLink = path.join(SNAPSHOTS, 'latest-successful');
	await fs.symlink(snapshotName, temporaryLink);
	await fs.rename(temporaryLink, latestLink);
}

async function main() {
	const dotEnv = loadDotEnv(path.join(ROOT, '.env'));
	const email = setting(dotEnv, 'ANYLIST_EMAIL');
	const password = setting(dotEnv, 'ANYLIST_PASSWORD');
	if (!email || !password) throw new Error('Missing ANYLIST_EMAIL or ANYLIST_PASSWORD.');

	await fs.mkdir(SNAPSHOTS, {recursive: true});
	const name = snapshotName();
	const staging = path.join(SNAPSHOTS, `.${name}.in-progress-${process.pid}`);
	const completed = path.join(SNAPSHOTS, name);
	await fs.mkdir(path.join(staging, 'recipes'), {recursive: true});
	await fs.mkdir(path.join(staging, 'photos'), {recursive: true});
	const manifest = {schemaVersion: 1, status: 'in-progress', startedAt: new Date().toISOString(), completedAt: null, counts: {recipes: 0, collections: 0, recipeCollectionMemberships: 0, photoReferences: 0, downloadedPhotos: 0}, files: {}, photos: [], errors: [], limitations: ['Recipe payloads are raw decoded fields from anylist@0.8.6.', 'All associated photos are attempted; photo IDs use the observed AnyList public JPEG CDN convention.', 'The protobuf system-collection settings map is omitted because this client decodes it as a cyclic internal structure; collection records and memberships are retained.', 'No scheduling is included.']};
	const any = new AnyList({email, password, credentialsFile: null});
	try {
		await any.login(false);
		await any.getRecipes(); // Exactly one recipe-inventory read via data/user-data/get.
		const recipeData = any._userData.recipeDataResponse;
		const rawRecipes = recipeData.recipes || [];
		const recipeIds = new Set(rawRecipes.map(recipe => recipe.identifier));
		manifest.counts.recipes = rawRecipes.length;
		for (const recipe of rawRecipes) await writeJson(path.join(staging, 'recipes'), `${recipe.identifier}.json`, plain(recipe));

		const collections = {allRecipesCollection: plain(recipeData.allRecipesCollection || null), recipeCollectionIds: plain(recipeData.recipeCollectionIds || []), recipeCollections: plain(recipeData.recipeCollections || []), pendingRecipeLinkRequests: plain(recipeData.pendingRecipeLinkRequests || [])};
		const memberships = collectionMemberships(recipeData, recipeIds);
		manifest.counts.collections = memberships.length;
		manifest.counts.recipeCollectionMemberships = memberships.reduce((count, membership) => count + membership.recipeIds.length, 0);
		manifest.files.collections = await writeJson(staging, 'collections.json', collections);
		manifest.files.memberships = await writeJson(staging, 'collection-memberships.json', memberships);

		for (const recipe of rawRecipes) {
			const references = photoReferences(recipe);
			manifest.counts.photoReferences += references.length;
			for (const [ordinal, reference] of references.entries()) {
				try {
					manifest.photos.push(await downloadPhoto(staging, recipe.identifier, reference, ordinal));
				} catch (error) {
					// Do not include source URLs in errors: URLs can carry sensitive query strings.
					manifest.errors.push({type: 'photo-download', recipeId: recipe.identifier, source: reference.source, photoId: reference.photoId || null, message: error.message});
				}
			}
		}
		manifest.counts.downloadedPhotos = manifest.photos.length;
		if (manifest.errors.length > 0) throw new Error(`${manifest.errors.length} photo download(s) failed`);
		manifest.files.recipes = {directory: 'recipes', count: rawRecipes.length};
		manifest.status = 'complete';
		manifest.completedAt = new Date().toISOString();
		await validateSnapshot(staging, manifest);
		manifest.files.manifest = await writeJson(staging, 'manifest.json', manifest);
		await fs.rename(staging, completed); // Atomic promotion: prior successful snapshots are untouched.
		await updateLatestSuccessful(name); // Only changed after the completed snapshot has validated.
		console.log(`Completed snapshot ${name}: ${manifest.counts.recipes} recipes, ${manifest.counts.downloadedPhotos} photos, ${manifest.counts.collections} collections.`);
	} catch (error) {
		manifest.status = 'failed';
		manifest.completedAt = new Date().toISOString();
		manifest.errors.push({type: 'backup', message: error.message});
		try { await writeJson(staging, 'manifest.json', manifest); } catch {}
		throw error;
	} finally {
		any.teardown();
	}
}

main().catch(error => {
	console.error(`Backup failed: ${error.message}`);
	process.exitCode = 1;
});
