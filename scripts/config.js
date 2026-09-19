'use strict';
const fsSync = require('node:fs');
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

module.exports = {loadDotEnv, setting};
