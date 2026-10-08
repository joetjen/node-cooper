# Examples

The [tutorial](TUTORIAL.md) builds one example — an orders service
config — up from nothing. This page walks through several more, each
focused on one thing you're likely to actually need `cooper` for. For
examples focused on CASC *syntax* rather than the surrounding
JavaScript, see [CASC_EXAMPLES.md](casc/CASC_EXAMPLES.md).

Every snippet here runs as-is; `//=>` shows what the expression before
it evaluates to, as `util.inspect(value, { depth: null })` prints it.

## Application config with a real secrets manager

The common shape: config loaded once at boot, with secrets fetched from
wherever your organization actually keeps them, never landing in source
control or a log line.

```casc
# config/app.casc
#@version = 1.0

database {
  *password = !{vault:secret/data/orders-db#password}
  host = "db.internal"
  pool_size = !int(${DB_POOL_SIZE:10})
}
```

<!-- check
const __realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => ({ data: { data: { password: 'correct-horse' } } }),
});
process.env.VAULT_ADDR = 'https://vault.internal:8200';
process.env.VAULT_TOKEN = 'test-token';
-->

```js
// config.js
import { loadFile, CooperError } from '@joetjen/cooper';

// `secret/data/orders-db#password` -> the `password` field of the KV v2
// secret at `secret/data/orders-db`.
async function fetchFromVault(payload) {
  const [secretPath, field] = payload.split('#');
  const response = await fetch(`${process.env.VAULT_ADDR}/v1/${secretPath}`, {
    headers: { 'X-Vault-Token': process.env.VAULT_TOKEN },
  });
  if (!response.ok) throw new Error(`vault read failed: ${response.status} ${response.statusText}`);
  const body = await response.json();
  return body.data.data[field];
}

export async function loadConfig() {
  try {
    return await loadFile('config/app.casc', { resolvers: { vault: fetchFromVault } });
  } catch (err) {
    if (err instanceof CooperError) throw new Error(`invalid config: ${err.message}`, { cause: err });
    throw err;
  }
}
```

```js
import { loadConfig } from './config.js';

const config = await loadConfig();
//=> {
//     database: { password: [~~REDACTED~~], host: 'db.internal', pool_size: 10 }
//   }
```

`config.database.password` comes back wrapped in `Secret` — safe to
hold in application state, pass around, and log by accident;
`config.database.password.reveal()` is the one deliberate step needed
to use the real value (e.g. when building a connection string for your
database driver). The resolver is async, so this needs `loadFile`, not
`loadFileSync`. If the resolver throws, the load rejects with a
`CooperError` naming the resolver and the payload, with your error as
its `cause`.

## Layering base config with per-environment overlays

```casc
# config/base.casc
#@version = 1.0

server { host = "0.0.0.0", port = 8080 }
log_level = info
feature_flags.new_checkout = false
```

```casc
# config/prod.casc
#@version = 1.0

import "base.casc"

~server { port = 443 }
log_level = warning
feature_flags.new_checkout = true
```

```js
import { loadFileSync } from '@joetjen/cooper';

loadFileSync('config/prod.casc');
//=> {
//     log_level: Symbol(warning),
//     feature_flags: { new_checkout: true },
//     server: { port: 443 }
//   }
```

`import` splices `base.casc`'s statements in first; every statement in
`prod.casc` after it — including `~server { port = 443 }`, which
replaces the whole block rather than merging — overrides the base at
the same path. (`server` comes last in the result because a `~`
replacement drops the old key and adds the new value afresh; an
ordinary override like `log_level` keeps its place.) Adding `config/staging.casc` alongside `prod.casc`, each
importing `base.casc` and overriding just what differs, avoids
duplicating the shared two-thirds of the file across every environment,
and picking the right one at startup is a one-liner:

```js
process.env.NODE_ENV = 'prod';

loadFileSync(`config/${process.env.NODE_ENV}.casc`).server;
//=> { port: 443 }
```

For per-environment *values* rather than whole config files —
`${DB_PASSWORD}` differing per environment, not `server.port` — a
`.env.<COOPER_ENV>` file (`.env.prod`) does the same job without a second `.casc` file
at all; see the tutorial's [§11](TUTORIAL.md#11-env-files).

## Reacting to a config or secret change without restarting

```casc
# config/app.casc
#@version = 1.0

database {
  *password = ${DB_PASSWORD}
  host = "db.internal"
}
```

<!-- check
process.env.DB_PASSWORD = 'first-password';
-->

```js
import diagnostics from 'node:diagnostics_channel';
import { loadFile, Cache } from '@joetjen/cooper';

let current = null; // whatever your app reads its config from

async function reload(msg) {
  current = await loadFile(msg.path);
}

diagnostics.subscribe('cooper:cache:file_changed', reload);
diagnostics.subscribe('cooper:cache:env_changed', reload);

current = await loadFile('config/app.casc');
```

`loadFile` already drops its own cache entry when either channel fires —
the handler doesn't need to know *why* something changed (a file edit,
an assignment to `process.env`, or a `.env` edit), just that calling
`loadFile` again now returns something different. `watchEnv` defaults
to on for any file that reads `${...}` at all, so a `*password =
${DB_PASSWORD}` secret rotated in the environment is covered with no
extra option, and a `${?NAME}`-guarded block's decision refreshes along
with it, not just ordinary values. The poll runs every 5 seconds; it's
shortened here only so the snippet finishes quickly:

```js
import { setTimeout as sleep } from 'node:timers/promises';

Cache.configure({ pollInterval: 100 });
await loadFile('config/app.casc'); // starts watching with the new interval

process.env.DB_PASSWORD = 'rotated-password';
await sleep(300);

current.database.password.reveal();
//=> 'rotated-password'
```

One caveat: `cooper:cache:file_changed` is published by the `loadFile`
call that *notices* a file changed — the cache checks modification
times on access, it doesn't watch the filesystem. To react to edits of
a config file nobody is reloading yet, pair it with `fs.watch` (or your
framework's file watcher) and call `loadFile` from there.

## Testing config-loading code without touching disk or the network

Every option that would otherwise reach for the real filesystem, the
environment, or an external service is a plain function or object —
which means a config loader can be unit-tested the same way as any
other function, with `node:test` and no fixtures directory or mocking
library:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadString } from '@joetjen/cooper';

test('prod overlay raises the connection pool', async () => {
  const source = `#@version = 1.0

import "mem://base"

pool_size = !int(\${POOL_SIZE:20})
`;

  const importSchemes = {
    mem: (name) => {
      assert.equal(name, 'base');
      return '#@version = 1.0\npool_size = 5\ndebug_routes = true\n';
    },
  };

  const config = await loadString(source, {
    importSchemes,
    env: { POOL_SIZE: '50' },
    dotenv: false,
  });

  assert.deepEqual(config, { pool_size: 50, debug_routes: true });
});
```

No real file named `base.casc` exists anywhere — `mem://base` is
resolved entirely in memory by the test's own `importSchemes` object.
(The `\${...}` escape is only there because the CASC source sits in a
JS template literal.) `POOL_SIZE` specifically is guaranteed to be
`'50'` regardless of `process.env` or any `.env` file, because `env`
always wins for a name it defines — see the tutorial's
[§11](TUTORIAL.md#11-env-files) for why that's an override, not full
isolation, and doesn't extend to `${...}` names the test's `env` object
doesn't mention. `dotenv: false` additionally keeps a developer's own
`.env` file out of the test.

## IP allowlisting with real CIDR math

```casc
# config/access.casc
#@version = 1.0

allowed_networks = [10.0.0.0/8, 192.168.1.0/24, 203.0.113.7/32]
```

```js
import { loadFileSync, IPv4 } from '@joetjen/cooper';

function isAllowed(config, remoteAddress) {
  const candidate = IPv4.parse(remoteAddress);
  return config.allowed_networks.some((network) => network.contains(candidate));
}

const config = loadFileSync('config/access.casc');

isAllowed(config, '10.1.2.3');
//=> true
isAllowed(config, '203.0.113.8');
//=> false
```

Every address in `allowed_networks` is a real `IPv4`, validated at load
time (a malformed address or an out-of-range CIDR prefix is a load-time
`CooperError`, never a crash reachable by a bad config file) —
`contains()` does genuine bitwise network-membership math, not a string
prefix comparison. `IPv4.parse` throws on a malformed string, so a
request handler should treat that as "not allowed". `IPv6` has the
same API, minus `broadcast()`.

## Generating per-shard config from one template

```casc
#@version = 1.0

defaults.shard {
  replicas = 1
  memory_limit = 512MiB
}

@shard_names = ["orders", "inventory", "billing"]
@shard_replicas = [3, 2, 1]

for @name in @{shard_names}, @replicas in @{shard_replicas}
  from defaults.shard as shards."@{name}" {
  replicas = @{replicas}
}
```

```js
import { loadStringSync } from '@joetjen/cooper';

loadStringSync(source);
//=> {
//     defaults: { shard: { replicas: 1, memory_limit: ByteSize(536870912B) } },
//     shards: {
//       orders: { replicas: 3, memory_limit: ByteSize(536870912B) },
//       inventory: { replicas: 2, memory_limit: ByteSize(536870912B) },
//       billing: { replicas: 1, memory_limit: ByteSize(536870912B) }
//     }
//   }
```

Each of the three shards starts as a full copy of `defaults.shard`
(`memory_limit` carries through unchanged to every one), with only
`replicas` overridden per shard from the parallel `@shard_replicas`
list — adding a fourth shard is one more entry in each of the two
lists, not a fourth copy-pasted block.

## A consumer-defined tagged value

Built-in tags (`!int`, `!float`, `!bool`, `!duration`, `!bytes`, ...)
cover type coercion; the `tags` option extends the same `!name(arg)`
syntax to your own vocabulary. A tag function receives the resolved
argument and returns whatever value it likes — here a real `URL`
object, validated at load time, not just a string pass-through:

```casc
#@version = 1.0

api.base_url = !url(${API_URL:"https://api.example.com/v2/"})
```

```js
import { loadStringSync } from '@joetjen/cooper';

const tags = {
  url: (arg) => new URL(arg), // throws a TypeError for an invalid URL
};

const config = loadStringSync(source, { tags });
config.api.base_url instanceof URL;
//=> true
new URL('orders', config.api.base_url).href;
//=> 'https://api.example.com/v2/orders'
```

A tag that throws fails the load with a `CooperError` naming the tag;
a config file using `!url(...)` without `tags` registered fails with
one too — never silently treated as an opaque string:

```js
try {
  loadStringSync(source, { tags, env: { API_URL: 'not a url' } });
} catch (err) {
  err.message;
  //=> '!url(...) failed: Invalid URL'
}

try {
  loadStringSync(source);
} catch (err) {
  err.message;
  //=> 'unregistered tag !url(...)'
}
```

## Pluggable handlers with `!module`

`!module("Name")` names a module the same way for every Cooper
implementation: dot-separated PascalCase. A Node module is a location,
not a name, so the application says where each name lives with the
`modules` load option — a specifier string (a relative one resolves
against the working directory, since the mapping is application code)
or the module itself. Loading the config never imports anything; you get
a `ModuleRef`, and call `load()` (a dynamic `import()`, or the module you
mapped, as is) when you actually need it:

```casc
# config/app.casc
#@version = 1.0

logging.formatter = !module(${LOG_FORMATTER:"Formatters.Plain"})
```

```js
// config/formatters/plain.js
export default function format(level, message) {
  return `${level.toUpperCase()} ${message}`;
}
```

```js
// config/formatters/json.js
export default function format(level, message) {
  return JSON.stringify({ level, message });
}
```

```js
import { loadFileSync } from '@joetjen/cooper';

// Run from the project root, so these resolve against it.
const modules = {
  'Formatters.Plain': './config/formatters/plain.js',
  'Formatters.Json': './config/formatters/json.js',
};

const config = loadFileSync('config/app.casc', { modules });
//=> { logging: { formatter: ModuleRef(Formatters.Plain) } }

const { default: format } = await config.logging.formatter.load();
format('info', 'ready');
//=> 'INFO ready'

const jsonConfig = loadFileSync('config/app.casc', { modules, env: { LOG_FORMATTER: 'Formatters.Json' } });
const { default: formatJson } = await jsonConfig.logging.formatter.load();
formatJson('info', 'ready');
//=> '{"level":"info","message":"ready"}'
```

`ref.name` is the name as written, `ref.specifier` what `load()` will
import (an absolute path, for a relative specifier), and `ref.value` the
module itself when the mapping held one rather than a string. A name that
isn't dot-separated PascalCase, or that `modules` doesn't hold, is a
load-time error, so a typo in `LOG_FORMATTER` fails at startup rather than
at the first log line.

## Turning a load failure into an actionable message

Every failure is a `CooperError` with a `stage`, and syntax errors also
carry `file`, `line`, and `column`, so a caller decides what
"actionable" means for its own context — here, a `validate-config`
script printing an `editor-clickable:line:column` location instead of
a stack trace:

```casc
# config/broken.casc
#@version = 1.0

server {
  port = = 8080
}
```

```js
// scripts/validate-config.js
import path from 'node:path';
import { loadFile, CooperError } from '@joetjen/cooper';

export function describeFailure(file, err) {
  if (!(err instanceof CooperError)) throw err;
  const where = err.file ? path.relative(process.cwd(), err.file) : file;
  const location = err.line ? `${where}:${err.line}:${err.column}` : where;
  return `${location} [${err.stage}]: ${err.message}`;
}

export async function validate(file) {
  try {
    await loadFile(file, { cache: false });
    return `${file}: OK`;
  } catch (err) {
    process.exitCode = 1;
    return describeFailure(file, err);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await validate(process.argv[2]));
}
```

```js
import { validate } from './scripts/validate-config.js';

await validate('config/broken.casc');
//=> 'config/broken.casc:5:10 [parser]: unexpected "=" at line 5, column 10 -- expected "!", "${", "%{", "(", ":", "@{", "[", "{", an identifier, value'
await validate('config/missing.casc');
//=> 'config/missing.casc [import]: could not read "config/missing.casc": no such file or directory'
```

<!-- check
process.exitCode = 0;
-->

Run it as `node scripts/validate-config.js config/app.casc` in CI. A
`CooperError` is the only thing any `cooper` load throws or rejects
with — your own resolver or tag errors included, wrapped with the
original kept as `err.cause` — so the single `instanceof` check covers
every failure mode.
