/**
 * Test setup file — loaded before all tests via .mocharc.json.
 *
 * Saves and restores the globals @simpleworkjs/bao-conf depends on
 * (global.fetch, process.env, console) so tests can stub fetch freely,
 * and clears the module cache so each test gets a fresh `configured` state.
 */

const path = require('path');

global.originalFetch = global.fetch;
global.originalEnv = { ...process.env };
global.originalWarn = console.warn;
global.originalError = console.error;

exports.mochaHooks = {
	beforeEach() {
		// Suppress expected warnings/errors from fail-soft paths.
		console.warn = () => {};
		console.error = () => {};

		// Fresh module load per test → `configured` starts null.
		const indexPath = path.join(__dirname, '..', 'index.js');
		delete require.cache[require.resolve(indexPath)];
	},

	afterEach() {
		// Restore fetch, console, env.
		global.fetch = global.originalFetch;
		console.warn = global.originalWarn;
		console.error = global.originalError;

		Object.keys(process.env).forEach(key => {
			if (!(key in global.originalEnv)) delete process.env[key];
		});
		Object.assign(process.env, global.originalEnv);
	}
};