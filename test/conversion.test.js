'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

async function main() {
	const root = path.resolve(__dirname, '..');
	const recipes = require('./fixtures/representative-recipes.json');
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anylist-conversion-test-'));
	try {
		await fs.mkdir(path.join(temporary, 'recipes'));
		for (const recipe of recipes) await fs.writeFile(path.join(temporary, 'recipes', `${recipe.identifier}.json`), `${JSON.stringify(recipe, null, 2)}\n`);
		await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify({status: 'complete', counts: {recipes: recipes.length}, photos: []}));
		const result = spawnSync(process.execPath, [path.join(root, 'convert-snapshot.js'), temporary, '--yaml', '--cooklang'], {encoding: 'utf8'});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		for (const recipe of recipes) {
			const yaml = YAML.parse(await fs.readFile(path.join(temporary, 'derived', 'yaml', 'recipes', `${recipe.identifier}.yaml`), 'utf8'));
			assert.deepEqual(yaml, recipe, `YAML round trip failed for ${recipe.identifier}`);
		}
		const cook = await fs.readFile(path.join(temporary, 'derived', 'cooklang', 'recipes', 'fixture-fraction-section.cook'), 'utf8');
		assert.match(cook, /@all-purpose flour\{1\/2%cup\}/);
		assert.match(cook, /= Batter/);
		assert.match(cook, /Whisk the dry ingredients\.\\\nFold in the milk\./);
		console.log('conversion fixtures passed');
	} finally {
		await fs.rm(temporary, {recursive: true, force: true});
	}
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
