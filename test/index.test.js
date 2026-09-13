/**
 * Tests for @simpleworkjs/bao-conf
 */

const { expect } = require('chai');

/**
 * Build a fetch stub from a map of `${METHOD} ${path-suffix}` → response spec.
 * Captures every call in `calls`. Response spec is either:
 *   { status, body }            — body is returned by .json()/.text()
 *   'throw'                      — the fetch call throws an Error
 *   a function(url, opts)        — returns a Response-like object
 */
function mockFetch(map) {
	const calls = [];
	const fn = async (url, opts) => {
		calls.push({ url, opts });
		const method = (opts && opts.method) || 'GET';
		// Match on the path after /v1/.
		const v1Idx = String(url).indexOf('/v1/');
		const suffix = v1Idx >= 0 ? String(url).slice(v1Idx + 4) : String(url);
		const key = `${method} ${suffix}`;
		let spec = map[key];
		if (spec === undefined) {
			// Fall back to method-only wildcard.
			spec = map[`${method} *`];
		}
		if (spec === undefined) throw new Error(`mockFetch: unexpected ${key} (url=${url})`);
		if (spec === 'throw') throw new Error(`mockFetch: simulated network error for ${key}`);
		if (typeof spec === 'function') return spec(url, opts);
		return makeResponse(spec);
	};
	fn.calls = calls;
	return fn;
}

/** Minimal Response-like object. */
function makeResponse({ status = 200, body = {} }) {
	return {
		status,
		ok: status >= 200 && status < 300,
		async json() { return body; },
		async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
	};
}

describe('@simpleworkjs/bao-conf', function() {
	let bao;

	beforeEach(() => {
		bao = require('../index.js');
		process.env.VAULT_ADDR = 'http://openbao:8200';
		process.env.VAULT_TOKEN = 'test-token';
	});

	describe('configure()', function() {
		it('throws if no token is available', function() {
			delete process.env.VAULT_TOKEN;
			expect(() => bao.configure()).to.throw(/VAULT_TOKEN/);
		});

		it('reads VAULT_ADDR / VAULT_TOKEN from env', function() {
			const cfg = bao.configure();
			expect(cfg.addr).to.equal('http://openbao:8200');
			expect(cfg.token).to.equal('test-token');
		});

		it('strips a trailing slash from addr', function() {
			const cfg = bao.configure({ addr: 'http://openbao:8200/', token: 't' });
			expect(cfg.addr).to.equal('http://openbao:8200');
		});

		it('honors explicit options over env', function() {
			const cfg = bao.configure({ addr: 'http://x:1234', token: 'override' });
			expect(cfg.addr).to.equal('http://x:1234');
			expect(cfg.token).to.equal('override');
		});
	});

	describe('request()', function() {
		it('sends X-Vault-Token and targets ${addr}/v1/<path>', async function() {
			global.fetch = mockFetch({
				'GET secret/data/foo': { status: 200, body: { data: { data: {} } } }
			});
			await bao.request('GET', 'secret/data/foo');
			const call = global.fetch.calls[0];
			expect(call.url).to.equal('http://openbao:8200/v1/secret/data/foo');
			expect(call.opts.headers['X-Vault-Token']).to.equal('test-token');
		});

		it('serializes a JSON body and sets Content-Type', async function() {
			global.fetch = mockFetch({ 'POST secret/data/foo': { status: 204, body: {} } });
			await bao.request('POST', 'secret/data/foo', { data: { a: 1 } });
			const call = global.fetch.calls[0];
			expect(call.opts.headers['Content-Type']).to.equal('application/json');
			expect(JSON.parse(call.opts.body)).to.deep.equal({ data: { a: 1 } });
		});
	});

	describe('get()', function() {
		it('returns the inner data object on 200', async function() {
			global.fetch = mockFetch({
				'GET secret/data/apps/x/conf': { status: 200, body: { data: { data: { oauth: { clientId: 'c' } } } } }
			});
			const data = await bao.get('apps/x/conf');
			expect(data).to.deep.equal({ oauth: { clientId: 'c' } });
		});

		it('returns null on 404', async function() {
			global.fetch = mockFetch({ 'GET secret/data/missing/conf': { status: 404, body: {} } });
			expect(await bao.get('missing/conf')).to.equal(null);
		});

		it('returns null (fail-soft) on a non-200 error', async function() {
			global.fetch = mockFetch({ 'GET secret/data/x/conf': { status: 500, body: 'boom' } });
			expect(await bao.get('x/conf')).to.equal(null);
		});

		it('returns null (fail-soft) on a network error', async function() {
			global.fetch = mockFetch({ 'GET *': 'throw' });
			expect(await bao.get('x/conf')).to.equal(null);
		});
	});

	describe('set()', function() {
		it('writes a KV-v2 { data } envelope and resolves on 2xx', async function() {
			global.fetch = mockFetch({ 'POST secret/data/proxy/conf': { status: 204, body: {} } });
			await bao.set('proxy/conf', { oauth: { clientId: 'c' } });
			const call = global.fetch.calls[0];
			expect(call.opts.method).to.equal('POST');
			expect(JSON.parse(call.opts.body)).to.deep.equal({ data: { oauth: { clientId: 'c' } } });
		});

		it('throws on a non-2xx response', async function() {
			global.fetch = mockFetch({ 'POST secret/data/proxy/conf': { status: 403, body: 'denied' } });
			let err;
			try { await bao.set('proxy/conf', { a: 1 }); } catch (e) { err = e; }
			expect(err).to.be.an('error');
			expect(err.message).to.match(/403/);
		});
	});

	describe('init()', function() {
		it('throws if conf or path is omitted', async function() {
			let err;
			try { await bao.init({ path: 'proxy' }); } catch (e) { err = e; }
			expect(err).to.be.an('error');
			expect(err.message).to.match(/`conf`/);
			err = undefined;
			try { await bao.init({ conf: {} }); } catch (e) { err = e; }
			expect(err).to.be.an('error');
			expect(err.message).to.match(/`path`/);
		});

		it('deep-merges vault data over the live conf object (nested merge)', async function() {
			global.fetch = mockFetch({
				'GET secret/data/proxy/conf': {
					status: 200,
					body: { data: { data: {
						oidc: { clientSecret: 'from-vault' },
						ldap: { bindPassword: 'vault-pw' },
						newKey: { nested: true }
					} } }
				}
			});
			const conf = { oidc: { clientId: 'cid', clientSecret: 'from-file' }, app: { port: 3000 } };
			const merged = await bao.init({ path: 'proxy', conf });
			// Returned object is the same reference, mutated in place.
			expect(merged).to.equal(conf);
			// Overlaid secret wins.
			expect(conf.oidc.clientSecret).to.equal('from-vault');
			// Non-overlaid nested key preserved (deep merge, not replace).
			expect(conf.oidc.clientId).to.equal('cid');
			// Existing top-level key preserved.
			expect(conf.app.port).to.equal(3000);
			// New keys added.
			expect(conf.ldap.bindPassword).to.equal('vault-pw');
			expect(conf.newKey.nested).to.equal(true);
		});

		it('fetches secret/data/<path>/conf with the scoped token', async function() {
			global.fetch = mockFetch({
				'GET secret/data/sso-manager/conf': { status: 200, body: { data: { data: {} } } }
			});
			await bao.init({ path: 'sso-manager', conf: {} });
			const call = global.fetch.calls[0];
			expect(call.url).to.equal('http://openbao:8200/v1/secret/data/sso-manager/conf');
			expect(call.opts.headers['X-Vault-Token']).to.equal('test-token');
		});

		it('fail-soft on 404: leaves conf untouched and resolves', async function() {
			global.fetch = mockFetch({ 'GET secret/data/proxy/conf': { status: 404, body: {} } });
			const conf = { app: { port: 3000 } };
			const merged = await bao.init({ path: 'proxy', conf });
			expect(merged).to.equal(conf);
			expect(conf).to.deep.equal({ app: { port: 3000 } });
		});

		it('fail-soft on network error: leaves conf untouched and resolves', async function() {
			global.fetch = mockFetch({ 'GET *': 'throw' });
			const conf = { app: { port: 3000 } };
			await bao.init({ path: 'proxy', conf });
			expect(conf).to.deep.equal({ app: { port: 3000 } });
		});

		it('fail-soft if no token: leaves conf untouched and resolves', async function() {
			delete process.env.VAULT_TOKEN;
			const conf = { app: { port: 3000 } };
			const merged = await bao.init({ path: 'proxy', conf });
			expect(merged).to.equal(conf);
			expect(conf).to.deep.equal({ app: { port: 3000 } });
		});
	});

	describe('an unset token is reported once, not once per read', function() {
		// Every get() re-ran configure(), which threw the same error every time,
		// and the catch logged it in full -- so a deployment with no VAULT_TOKEN
		// emitted one identical error per secret read. On theta-directory's
		// end-to-end suite that was 108 copies of the same message per run, in
		// passing runs as much as failing ones, which is enough noise to bury the
		// failure you are looking for.
		let logged;
		let originalError;

		beforeEach(function() {
			delete process.env.VAULT_TOKEN;
			bao._reset();
			logged = [];
			originalError = console.error;
			console.error = (...args) => logged.push(args.join(' '));
		});

		afterEach(function() {
			console.error = originalError;
			bao._reset();
		});

		it('logs the condition once across many reads, and still fails soft', async function() {
			const results = [];
			for (let i = 0; i < 10; i++) {
				results.push(await bao.get(`some/path-${i}`));
			}

			// Fail-soft is unchanged: every read still resolves to null.
			expect(results).to.deep.equal(new Array(10).fill(null));

			const tokenWarnings = logged.filter(line => /VAULT_TOKEN is not set/.test(line));
			expect(tokenWarnings).to.have.lengthOf(1);
			// And it says what happens next, so the silence afterwards is expected
			// rather than mysterious.
			expect(tokenWarnings[0]).to.match(/further reads will be skipped silently/);
		});

		it('still reports a genuine per-read error every time', async function() {
			// The quieting is specific to the configuration fault. A read that
			// fails for its own reason is a separate event each time and must
			// keep saying so.
			process.env.VAULT_TOKEN = 'test-token';
			bao._reset();
			global.fetch = mockFetch({ 'GET *': 'throw' });

			await bao.get('some/path');
			await bao.get('other/path');

			const readErrors = logged.filter(line => /error reading secret\/data\//.test(line));
			expect(readErrors).to.have.lengthOf(2);
		});
	});
});