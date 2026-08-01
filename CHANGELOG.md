# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-08-01

### Added
- Initial release. Async OpenBao / HashiCorp Vault KV-v2 secrets overlay for
  `@simpleworkjs/conf`.
- `init({ path, conf })` — fetches `secret/data/<path>/conf` at boot and
  **deep-merges** it over the live `conf` object in place, so values loaded
  synchronously by `@simpleworkjs/conf` are overlaid with OpenBao values
  before any request is served. Fail-soft on error/missing path.
- `get(path)` / `set(path, data)` — read/write KV-v2 secrets.
- `request(method, vaultPath, body)` — low-level OpenBao API helper (used by
  application-side token/policy brokers).
- `configure({ addr, token })` — resolve/cache connection config from options
  or `VAULT_ADDR` / `VAULT_TOKEN`. No root-token fallback — a scoped token is
  required, so misconfiguration throws loudly.
- Mocha test suite (18 tests) covering deep-merge, fail-soft, set/get, and the
  boot-order contract.
- Documentation site + GitHub Pages workflow.