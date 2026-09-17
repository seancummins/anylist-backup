'use strict';

// Offline-only derived-format converter. It never imports AnyList or performs network I/O.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');

function usage() {
	throw new Error('Usage: node convert-snapshot.js <completed-snapshot-directory> --yaml [--cooklang]');
}

function sha256(data) {
	return crypto.createHash('sha256').update(data).digest('hex');
}

function equalJson(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function duration(seconds) {
	if (typeof seconds !== 'number') return null;
	if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
	if (seconds % 60 === 0) return `${seconds / 60} minutes`;
	return `${seconds} seconds`;
}

function cookServings(value) {
	if (typeof value === 'number') return value;
	const match = String(value).match(/^\s*(\d+(?:\.\d+)?)/);
	return match ? Number(match[1]) : null;
}

function escapeCookText(value) {
	return String(value).replace(/\\/g, '\\\\').replace(/@/g, '\\@').replace(/#/g, '\\#').replace(/~/g, '\\~').replace(/--/g, '\\-\\-');
}

function ingredientMarkup(ingredient) {
	const name = escapeCookText(ingredient.name || ingredient.rawIngredient || 'unnamed ingredient').replace(/[{}]/g, '\\$&');
	const quantity = ingredient.quantity == null ? '' : String(ingredient.quantity).trim();
	const note = ingredient.note == null || ingredient.note === '' ? '' : `(${escapeCookText(ingredient.note)})`;
	if (!quantity) return `@${name}{}${note}`;
	const match = quantity.match(/^((?:=)?(?:(?:\d+\/\d+)|(?:\d+(?:\.\d+)?))(?:\s+\d+\/\d+)?(?:\s*-\s*(?:(?:\d+\/\d+)|(?:\d+(?:\.\d+)?)))?)\s*(.*)$/);
	if (!match) return `@${name}{${escapeCookText(quantity)}}${note}`;
	const [, amount, unit] = match;
	return unit ? `@${name}{${amount}%${escapeCookText(unit)}}${note}` : `@${name}{${amount}}${note}`;
}

function cookMetadata(recipe, photoFiles) {
	const metadata = {
		title: recipe.name || recipe.identifier,
		'anylist.id': recipe.identifier,
		'anylist.timestamp': recipe.timestamp,
	};
	if (recipe.note != null) metadata.description = recipe.note;
	if (recipe.servings != null) {
		const servings = cookServings(recipe.servings);
		if (servings !== null) metadata.servings = servings;
		metadata['anylist.servings'] = recipe.servings;
	}
	if (recipe.sourceName != null) metadata['source.name'] = recipe.sourceName;
	if (recipe.sourceUrl != null) metadata['source.url'] = recipe.sourceUrl;
	if (recipe.prepTime != null) metadata['prep time'] = duration(recipe.prepTime);
	if (recipe.cookTime != null) metadata['cook time'] = duration(recipe.cookTime);
	if (recipe.rating != null) metadata['anylist.rating'] = recipe.rating;
	if (recipe.scaleFactor != null) metadata['anylist.scale_factor'] = recipe.scaleFactor;
	if (photoFiles.length > 0) metadata.images = photoFiles.map(file => path.posix.join('../../../', file));
	return metadata;
}

function companion(recipe, photoFiles) {
	return {
		recipeId: recipe.identifier,
		authoritativeSource: path.posix.join('../../../recipes', `${recipe.identifier}.json`),
		localPhotoFiles: photoFiles.map(file => path.posix.join('../../../', file)),
		unrepresentedOrLossyFields: {
			icon: recipe.icon, adCampaignId: recipe.adCampaignId, nutritionalInfo: recipe.nutritionalInfo,
			paprikaIdentifier: recipe.paprikaIdentifier, recipeDataId: recipe.recipeDataId,
			creationTimestamp: recipe.creationTimestamp, photoIds: recipe.photoIds, photoUrls: recipe.photoUrls,
			ingredients: (recipe.ingredients || []).map(({identifier, rawIngredient, isHeading, ...rest}) => ({identifier, rawIngredient, isHeading, ...rest})),
		},
	};
}

function cookText(recipe, photoFiles) {
	const blocks = [`---\n${YAML.stringify(cookMetadata(recipe, photoFiles)).trimEnd()}\n---`];
	blocks.push('= Ingredients (unlinked)');
	for (const ingredient of recipe.ingredients || []) {
		if (ingredient.isHeading) blocks.push(`= ${escapeCookText(ingredient.name || ingredient.rawIngredient || 'Untitled section')}`);
		else blocks.push(ingredientMarkup(ingredient));
	}
	if ((recipe.preparationSteps || []).length > 0) {
		blocks.push('= Instructions');
		for (const step of recipe.preparationSteps) blocks.push(String(step).split(/\r?\n/).map(escapeCookText).join('\\\n'));
	} else {
		blocks.push('= Instructions\n> No preparation steps were available in the source recipe.');
	}
	return `${blocks.join('\n\n')}\n`;
}

async function parseCooklang(source) {
	const {Parser} = await import('@cooklang/cooklang');
	const parsed = new Parser().parse(source);
	if (parsed.report && parsed.report.trim()) throw new Error(parsed.report.trim());
	return parsed;
}

async function ensureCompleteSnapshot(snapshot) {
	const manifest = JSON.parse(await fs.readFile(path.join(snapshot, 'manifest.json'), 'utf8'));
	if (manifest.status !== 'complete') throw new Error('Snapshot is not complete; derived formats are only allowed from validated snapshots.');
	return manifest;
}

async function main() {
	const [snapshotArgument, ...flags] = process.argv.slice(2);
	if (!snapshotArgument || !flags.includes('--yaml')) usage();
	const cooklang = flags.includes('--cooklang');
	const snapshot = path.resolve(snapshotArgument);
	const sourceManifest = await ensureCompleteSnapshot(snapshot);
	const recipeDirectory = path.join(snapshot, 'recipes');
	const recipeFiles = (await fs.readdir(recipeDirectory)).filter(file => file.endsWith('.json')).sort();
	if (recipeFiles.length !== sourceManifest.counts.recipes) throw new Error('Recipe count differs from the completed snapshot manifest.');
	const target = path.join(snapshot, 'derived');
	const stage = path.join(snapshot, `.derived-${process.pid}.in-progress`);
	await fs.mkdir(path.join(stage, 'yaml', 'recipes'), {recursive: true});
	if (cooklang) await fs.mkdir(path.join(stage, 'cooklang', 'recipes'), {recursive: true});
	const manifest = {schemaVersion: 1, sourceSnapshot: path.basename(snapshot), status: 'in-progress', startedAt: new Date().toISOString(), completedAt: null, yaml: {status: 'in-progress', converted: 0, failures: []}, cooklang: cooklang ? {status: 'in-progress', converted: 0, failures: []} : {status: 'not-requested', converted: 0, failures: []}};
	try {
		const photoMap = new Map();
		for (const photo of sourceManifest.photos || []) photoMap.set(photo.recipeId, [...(photoMap.get(photo.recipeId) || []), photo.file]);
		for (const file of recipeFiles) {
			const recipe = JSON.parse(await fs.readFile(path.join(recipeDirectory, file), 'utf8'));
			try {
				if (!recipe.identifier || file !== `${recipe.identifier}.json`) throw new Error('stable recipe ID does not match source filename');
				const yaml = YAML.stringify(recipe);
				if (!equalJson(YAML.parse(yaml), recipe)) throw new Error('YAML round-trip does not reproduce source JSON');
				await fs.writeFile(path.join(stage, 'yaml', 'recipes', `${recipe.identifier}.yaml`), yaml);
				manifest.yaml.converted++;
			} catch (error) {
				manifest.yaml.failures.push({recipeId: recipe.identifier || file, message: error.message});
			}
			if (cooklang) {
				try {
					const source = cookText(recipe, photoMap.get(recipe.identifier) || []);
					await parseCooklang(source); // Official Cooklang WASM parser.
					await fs.writeFile(path.join(stage, 'cooklang', 'recipes', `${recipe.identifier}.cook`), source);
					await fs.writeFile(path.join(stage, 'cooklang', 'recipes', `${recipe.identifier}.companion.json`), `${JSON.stringify(companion(recipe, photoMap.get(recipe.identifier) || []), null, 2)}\n`);
					manifest.cooklang.converted++;
				} catch (error) {
					manifest.cooklang.failures.push({recipeId: recipe.identifier || file, message: error.message});
				}
			}
		}
		manifest.yaml.status = manifest.yaml.failures.length ? 'partial' : 'complete';
		if (cooklang) manifest.cooklang.status = manifest.cooklang.failures.length ? 'partial' : 'complete';
		manifest.status = manifest.yaml.status === 'complete' && (!cooklang || manifest.cooklang.status === 'complete') ? 'complete' : 'partial';
		manifest.completedAt = new Date().toISOString();
		await fs.writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
		try {
			await fs.rename(target, path.join(snapshot, `derived.previous-${Date.now()}`));
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		await fs.rename(stage, target);
		console.log(`Conversion ${manifest.status}: YAML ${manifest.yaml.converted}/${recipeFiles.length}${cooklang ? `, Cooklang ${manifest.cooklang.converted}/${recipeFiles.length}` : ''}.`);
		if (manifest.status !== 'complete') process.exitCode = 2;
	} catch (error) {
		manifest.status = 'failed';
		manifest.completedAt = new Date().toISOString();
		manifest.failure = error.message;
		try { await fs.writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`); } catch {}
		throw error;
	}
}

main().catch(error => {
	console.error(`Conversion failed: ${error.message}`);
	process.exitCode = 1;
});
