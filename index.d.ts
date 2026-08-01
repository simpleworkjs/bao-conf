/**
 * OpenBao / Vault KV-v2 secrets overlay for @simpleworkjs/conf.
 *
 * This package does not define your config shape — @simpleworkjs/conf does.
 * Extend that package's `Config` interface for typed access to your values.
 */

/** Per-call connection overrides. */
export interface VaultOpts {
	addr?: string;
	token?: string;
}

/** Options for {@link init}. */
export interface InitOptions extends VaultOpts {
	/** App namespace, e.g. `sso-manager`, `proxy`, `jump-host`. */
	path: string;
	/** The live @simpleworkjs/conf object to deep-merge OpenBao values into. */
	conf: Record<string, any>;
}

/** Resolved OpenBao connection config. */
export interface VaultConfig {
	addr: string;
	token: string;
}

/**
 * Fetch `secret/data/<path>/conf` and deep-merge it over the live `conf`
 * object in place. Fail-soft on error/missing. Must resolve before any
 * require-time consumer of an overlaid secret (e.g. `conf.oidc.clientSecret`).
 */
export function init(options: InitOptions): Promise<Record<string, any>>;

/** Read a KV-v2 secret at `secret/data/<path>`; returns null if absent/error. */
export function get(path: string, opts?: VaultOpts): Promise<Record<string, any> | null>;

/** Write a KV-v2 secret at `secret/data/<path>`. Throws on non-2xx. */
export function set(path: string, data: Record<string, any>, opts?: VaultOpts): Promise<Record<string, any>>;

/** Low-level OpenBao API request below `/v1/`. Returns the raw fetch Response. */
export function request(method: string, vaultPath: string, body?: Record<string, any>, opts?: VaultOpts): Promise<Response>;

/** Resolve and cache addr/token from options or env (VAULT_ADDR / VAULT_TOKEN). Throws if no token. */
export function configure(opts?: VaultOpts): VaultConfig;