# @simpleworkjs/bao-conf

OpenBao / HashiCorp Vault KV-v2 **secrets overlay** for
[`@simpleworkjs/conf`](https://www.npmjs.com/package/@simpleworkjs/conf).

[![npm version](https://img.shields.io/npm/v/@simpleworkjs/bao-conf.svg)](https://www.npmjs.com/package/@simpleworkjs/bao-conf)
[![Tests](https://github.com/simpleworkjs/bao-conf/workflows/Tests/badge.svg)](https://github.com/simpleworkjs/bao-conf/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

[View Full Documentation](https://simpleworkjs.github.io/bao-conf/)

`@simpleworkjs/conf` loads its config object **synchronously at `require()` time**
(`base.js` → `<env>.js` → `secrets.js` → `app_*` env) and exposes no async hook.
`@simpleworkjs/bao-conf` performs the complementary async step: at boot, after
`require('@simpleworkjs/conf')` returns, call `init({ path, conf })` to fetch
`secret/data/<path>/conf` from OpenBao and **deep-merge** it over the live `conf`
object in place. Because the merge mutates the same reference every consumer
already holds, code that reads `conf.ldap.bindPassword` at *call* time picks up the
OpenBao value automatically.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [The Boot-Order Constraint](#the-boot-order-constraint)
- [API Reference](#api-reference)
- [Environment Variables](#environment-variables)
- [Examples](#examples)
- [Best Practices](#best-practices)
- [Development](#development)

## Installation

```bash
npm install --save @simpleworkjs/bao-conf @simpleworkjs/conf
```

Requires Node.js >= 18 (uses the global `fetch`).

## Quick Start

```js
const conf = require('@simpleworkjs/conf');
const baoConf = require('@simpleworkjs/bao-conf');

// After @simpleworkjs/conf has loaded, overlay secrets from OpenBao.
// Fetches secret/data/sso-manager/conf and deep-merges it into `conf`.
await baoConf.init({ path: 'sso-manager', conf });

console.log(conf.ldap.bindPassword);   // now the OpenBao value
console.log(conf.oidc.clientSecret);   // now the OpenBao value
```

`init()` is **fail-soft**: if OpenBao is unreachable or the path is absent, it
logs a warning, leaves `conf` untouched, and resolves — so a missing overlay never
crashes boot. Make sure your file-loaded config is a safe fallback.

## The Boot-Order Constraint

This is the one subtlety that matters. Some code **captures** a secret at
`require()` time rather than reading it at call time. The canonical example is an
OIDC client built during `require('../models')`:

```js
// models/index.js — runs at require time
const oidcClient = createOidcClient({ clientSecret: conf.oidc.clientSecret });
```

`init()` mutates `conf` *after* it returns — so any value already captured into a
closure will **not** see the overlay. The fix is to ensure `init()` resolves
**before** the capturing `require()` runs. Wrap your `bin/www` so the fetch
happens first:

```js
const conf = require('@simpleworkjs/conf');
const baoConf = require('@simpleworkjs/bao-conf');

baoConf.init({ path: 'proxy', conf }).then(() => {
  const app = require('../app');   // models + createOidcClient now see merged conf
  const server = http.createServer(app);
  server.listen(port);
}).catch(err => { console.error('boot failed:', err); process.exit(1); });
```

If your `bin/www` already requires `../models` as an explicit line (e.g. jump-host),
gate that line:

```js
const conf = require('@simpleworkjs/conf');
require('@simpleworkjs/bao-conf').init({ path: 'jump-host', conf }).then(() => {
  require('../models');            // createOidcClient sees merged conf.oidc
  const app = require('../app');
  server.listen(webPort);
  sshServer.start();
});
```

Values read at *call* time (e.g. `conf.ldap.bindPassword` inside a lookup
function) need no special handling — they see the overlay whenever it has
resolved.

## API Reference

### `init({ path, conf, addr?, token? }) → Promise<conf>`

Fetch `secret/data/<path>/conf` and deep-merge it over `conf` in place. Fail-soft
on error/404. Throws if `path`/`conf` are omitted or no token is available.

### `get(path, opts?) → Promise<object|null>`

Read a KV-v2 secret at `secret/data/<path>`. Returns the inner data object, or
`null` if absent / on error (fail-soft).

### `set(path, data, opts?) → Promise<object>`

Write a KV-v2 secret at `secret/data/<path>` (wrapped as `{ data }` per KV-v2).
Throws on a non-2xx response. Used by bootstraps that write generated creds into
OpenBao.

### `request(method, vaultPath, body?, opts?) → Promise<Response>`

Low-level OpenBao API request below `/v1/`. Returns the raw `fetch` `Response`.
Used by application-side brokers that mint scoped tokens or write policies
(`auth/token/create/<role>`, `sys/policies/acl/<name>`, …).

### `configure({ addr?, token? }) → { addr, token }`

Resolve and cache the OpenBao connection config from options or env. Called
implicitly by `init`/`get`/`set`/`request`; exported for explicit setup. Throws
if no token is available.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `VAULT_ADDR` | OpenBao API URL | `http://openbao:8200` |
| `VAULT_TOKEN` | OpenBao token (scoped — **no root fallback**) | _required_ |

`opts.addr` / `opts.token` override the env on a per-call basis.

## Examples

### Bootstrap writing generated creds into OpenBao

```js
const baoConf = require('@simpleworkjs/bao-conf');
// BOOTSTRAP_VAULT_TOKEN has write policy on secret/proxy/conf etc.
await baoConf.set('proxy/conf', { oauth: { clientId, clientSecret } });
```

### A token/policy broker (server-side, scoped tokens)

```js
const baoConf = require('@simpleworkjs/bao-conf');
// Create a per-user policy, then mint a scoped token through a role.
await baoConf.request('PUT', `sys/policies/acl/user-${uid}`, {
  policy: `path "secret/users/${uid}/*" { capabilities = ["create","read","update","delete","list"] }`
});
const res = await baoConf.request('POST', 'auth/token/create/sso-broker', { policy: `user-${uid}` });
const { auth } = await res.json();
// auth.client_token is the per-user token — inject it as X-Vault-Token on proxied requests.
```

## Best Practices

- **Mint scoped per-app tokens** in your setup/orchestration and pass them via
  `VAULT_TOKEN`. Never propagate the OpenBao root token to application containers.
- **Call `init()` before any require-time capture** of an overlaid secret (see
  [The Boot-Order Constraint](#the-boot-order-constraint)).
- **Keep file-loaded config as a safe fallback** — `init()` is fail-soft by design;
  make sure the app can still boot (degraded) if OpenBao is unavailable.
- **Use fail-soft for boot config, fail-loud for writes** — `init`/`get` resolve
  on error; `set` throws. Don't wrap `set` in a swallow-catch during bootstrap.
- **Deep-merge, don't replace** — `init` deep-merges, so partial overlays (just
  the secrets) work without re-stating the whole config in OpenBao.

## Development

```bash
npm install
npm test              # mocha
npm run test:coverage # c8 mocha
```

Contributions welcome — see the [GitHub repository](https://github.com/simpleworkjs/bao-conf).