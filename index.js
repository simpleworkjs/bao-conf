'use strict';

const extend = require('extend');

/**
 * @simpleworkjs/bao-conf
 *
 * Async OpenBao / HashiCorp Vault KV-v2 secrets overlay for @simpleworkjs/conf.
 *
 * @simpleworkjs/conf loads its config object **synchronously at require time**
 * (base.js → <env>.js → secrets.js → app_* env). There is no async hook in that
 * loader. This package performs the complementary async step: at boot, after
 * `require('@simpleworkjs/conf')` has returned, call `init({ path, conf })` to
 * fetch `secret/data/<path>/conf` from OpenBao and **deep-merge** it over the
 * live `conf` object in place. Because the merge mutates the same object every
 * consumer already holds, code that reads `conf.ldap.bindPassword` at call time
 * picks up the OpenBao value automatically.
 *
 * IMPORTANT boot-order constraint: any code that *captures* a secret at require
 * time (e.g. an OIDC client built with `conf.oidc.clientSecret` during
 * `require('../models')`) will NOT see the overlay unless `init()` resolves
 * first. Call `init()` before the require that captures the secret — see the
 * README/docs for the `bin/www` wrapping patterns.
 *
 * Auth: OpenBao is addressed at `VAULT_ADDR` (default `http://openbao:8200`)
 * and authenticated with `VAULT_TOKEN`. There is deliberately **no root-token
 * fallback** — deployments mint scoped per-app tokens (see theta-env setup.sh)
 * and pass them via `VAULT_TOKEN`. `init()` (the boot overlay) is **fail-soft**:
 * if `VAULT_TOKEN` is unset or OpenBao is unreachable, it warns and leaves the
 * file-loaded config in place so boot continues. The explicit `get`/`set`/
 * `request` helpers, by contrast, throw on a missing token — they are
 * intentional operations against OpenBao, not a boot-time overlay.
 */

let configured = null; // { addr, token }

/**
 * Resolve and cache the OpenBao connection config from options or env.
 *
 * @param {Object} [opts]
 * @param {string} [opts.addr]   OpenBao API URL; defaults to `VAULT_ADDR` or `http://openbao:8200`.
 * @param {string} [opts.token]  OpenBao token; defaults to `VAULT_TOKEN`. Required (no fallback).
 * @returns {{addr: string, token: string}}
 * @throws {Error} if no token is available.
 */
function configure(opts = {}) {
	const addr = (opts.addr || process.env.VAULT_ADDR || 'http://openbao:8200').replace(/\/+$/, '');
	const token = opts.token || process.env.VAULT_TOKEN;
	if (!token) {
		throw new Error(
			'@simpleworkjs/bao-conf: VAULT_TOKEN is not set. Pass a `token` option ' +
			'or set the VAULT_TOKEN env var to a scoped OpenBao token (not root).'
		);
	}
	configured = { addr, token };
	return configured;
}

function getConfig() {
	if (!configured) configure();
	return configured;
}

/**
 * Low-level OpenBao API request. Returns the raw `fetch` Response.
 *
 * @param {string} method        HTTP method.
 * @param {string} vaultPath     Path below `/v1/` (e.g. `secret/data/foo`, `auth/token/create/sso-broker`).
 * @param {Object} [body]        JSON body, if any.
 * @param {Object} [opts]        Per-call override `{ addr, token }`.
 * @returns {Promise<Response>}
 */
async function request(method, vaultPath, body, opts = {}) {
	const cfg = (opts.addr || opts.token)
		? { addr: (opts.addr || getConfig().addr).replace(/\/+$/, ''), token: opts.token || getConfig().token }
		: getConfig();
	const url = `${cfg.addr}/v1/${String(vaultPath).replace(/^\//, '')}`;
	const headers = { 'X-Vault-Token': cfg.token };
	let payload;
	if (body !== undefined && body !== null) {
		headers['Content-Type'] = 'application/json';
		payload = JSON.stringify(body);
	}
	return fetch(url, { method, headers, body: payload });
}

/**
 * Read a KV-v2 secret at `secret/data/<path>`.
 *
 * @param {string} path   Path below `secret/data/` (e.g. `sso-manager/conf`, `apps/myapp/conf`).
 * @param {Object} [opts] Per-call override `{ addr, token }`.
 * @returns {Promise<Object|null>} The inner data object, or null if absent / on error (fail-soft).
 */
async function get(path, opts = {}) {
	try {
		const res = await request('GET', `secret/data/${path}`, undefined, opts);
		if (res.status === 200) {
			const json = await res.json();
			return json && json.data && json.data.data !== undefined ? json.data.data : null;
		}
		if (res.status === 404) return null;
		// Non-200, non-404: log + fail soft.
		const text = await res.text().catch(() => '');
		console.error(`@simpleworkjs/bao-conf: GET secret/data/${path} returned ${res.status} ${text}`);
	} catch (err) {
		console.error(`@simpleworkjs/bao-conf: error reading secret/data/${path}:`, err);
	}
	return null;
}

/**
 * Write a KV-v2 secret at `secret/data/<path>` with the given data object.
 *
 * @param {string} path   Path below `secret/data/`.
 * @param {Object} data   The data to store (wrapped as `{ data }` per KV-v2).
 * @param {Object} [opts] Per-call override `{ addr, token }`.
 * @returns {Promise<Object>} The OpenBao response body (or `{}` if empty).
 * @throws {Error} on a non-2xx response.
 */
async function set(path, data, opts = {}) {
	const res = await request('POST', `secret/data/${path}`, { data }, opts);
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`@simpleworkjs/bao-conf: Vault API error writing secret/data/${path}: ${res.status} ${text}`);
	}
	return res.json().catch(() => ({}));
}

/**
 * Fetch `secret/data/<path>/conf` and deep-merge it over the live `conf`
 * object in place. Fail-soft: on any error, missing path, or non-200, leaves
 * `conf` untouched and resolves (boot continues with the file-loaded config).
 *
 * @param {Object} params
 * @param {string} params.path   App namespace (e.g. `sso-manager`, `proxy`, `jump-host`).
 * @param {Object} params.conf   The live `@simpleworkjs/conf` object to merge into.
 * @param {string} [params.addr] Override `VAULT_ADDR`.
 * @param {string} [params.token] Override `VAULT_TOKEN`.
 * @returns {Promise<Object>} The merged `conf` object.
 * @throws {Error} if `path` or `conf` is omitted. **Fail-soft on a missing
 *   token**: if `VAULT_TOKEN` is unset (OpenBao not configured for this
 *   process — standalone Docker, bare metal, CI), `init()` warns and resolves
 *   with `conf` unchanged rather than crashing boot.
 */
async function init({ path, conf, addr, token } = {}) {
	if (!conf) throw new Error("@simpleworkjs/bao-conf: init() requires a `conf` option (the @simpleworkjs/conf object).");
	if (!path) throw new Error("@simpleworkjs/bao-conf: init() requires a `path` option (e.g. 'sso-manager', 'proxy').");
	// Fail-soft on "OpenBao not configured": if no token is available there is
	// nothing to overlay — this is the normal case for standalone Docker,
	// bare metal, and CI test images that run without an OpenBao sidecar.
	// Boot continues from the file-loaded config. (The explicit get/set/request
	// helpers still throw on a missing token — only the boot overlay is soft.)
	try {
		configure({ addr, token });
	} catch (err) {
		console.warn(`@simpleworkjs/bao-conf: ${err.message} — skipping OpenBao overlay, continuing with file-loaded config.`);
		return conf;
	}
	const vaultConf = await get(`${path}/conf`);
	if (vaultConf) {
		// Deep merge into the live conf object so every holder of the reference
		// sees the overlay. extend(true, dest, src) mutates dest in place.
		extend(true, conf, vaultConf);
	} else {
		console.warn(`@simpleworkjs/bao-conf: no conf at secret/data/${path}/conf — continuing with file-loaded config.`);
	}
	return conf;
}

module.exports = { init, get, set, request, configure };