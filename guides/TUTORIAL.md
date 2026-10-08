# Tutorial

This tutorial builds up a small "orders service" config file, feature by
feature, until it exercises every part of CASC that `cooper` implements.
By the end you'll know how to load config (and when to use the sync or
the async API), handle secrets and errors, inject test-time
environment/import values, guard statements on an env var, layer `.env`
files, and use `cooper`'s own caching and change-notification support —
and you'll have seen enough CASC syntax to write and read real config
files. For the full language reference, see [CASC.md](casc/CASC.md);
the [CASC tutorial](casc/TUTORIAL.md) covers the language itself in
more depth than this one does.

Every snippet here runs as-is. A `//=>` comment shows what the
expression before it evaluates to, rendered the way
`util.inspect(value, { depth: null })` (or `console.dir(value, { depth:
null })`) prints it. Where a snippet loads `source`, `source` is the
CASC block shown just above it, as a string.

## 1. The minimal file

Every CASC file needs a version header — a comment-shaped line that
also declares which version of the language the file is written
against:

```casc
#@version = 1.0
```

That alone is a complete, valid file:

```js
import { loadString } from '@joetjen/cooper';

await loadString('#@version = 1.0');
//=> {}
```

`loadString` parses a CASC source string directly. `loadFile` reads a
file from disk first — use it for real config files; `loadString` is
convenient for tests and for this tutorial. Both return a `Promise` of
the loaded config, a plain object, and reject with a `CooperError` on
failure; see [§6](#6-errors).

`cooper` ships both an ES module and a CommonJS entry point, so
`require` works just as well:

```js
const { loadStringSync } = require('@joetjen/cooper');

loadStringSync('#@version = 1.0');
//=> {}
```

### Sync or async?

Each loader comes in two flavours, a split the Elixir original doesn't
have:

| | Returns | Resolvers, tags, import schemes may be |
|---|---|---|
| `loadFile(path, opts)` / `loadString(source, opts)` | a `Promise` | sync **or** async |
| `loadFileSync(path, opts)` / `loadStringSync(source, opts)` | the config | sync only |

Reach for the `*Sync` pair for the common case — plain files loaded
once at startup, before the server starts listening, or at the top of a
CommonJS module where there's no `await`. Use the async pair as soon as
anything you register has to wait on I/O: a resolver that asks a
secrets manager over the network (§10), or an `import "scheme://..."`
loader that fetches remote config (§7). Both pairs run the exact same
pipeline and produce identical results; the sync pair just refuses a
callback that hands back a `Promise`, with an error saying so, rather
than silently putting a `Promise` into your config:

```js
import { loadStringSync } from '@joetjen/cooper';

try {
  loadStringSync('#@version = 1.0\ntoken = !{vault:api/token}', {
    resolvers: { vault: async (path) => `token-for-${path}` },
  });
} catch (err) {
  err.message;
  //=> 'resolver "vault" returned a Promise -- use the async API (loadFile/loadString) instead of the *Sync variant'
}
```

The rest of this tutorial uses whichever reads better for each example.

## 2. Plain values and blocks

Assignments look like ordinary key/value pairs. Nested blocks build
dotted paths automatically:

```casc
#@version = 1.0

app_name = "orders"
replicas = 3

server {
  host = "0.0.0.0"
  port = 8080
}
```

```js
import { loadStringSync } from '@joetjen/cooper';

loadStringSync(source);
//=> {
//     app_name: 'orders',
//     replicas: 3,
//     server: { host: '0.0.0.0', port: 8080 }
//   }
```

`server { host = ... }` and `server.host = ...` are equivalent — pick
whichever reads better for a given block. Keys are always strings, so
the result is a plain object you can destructure, spread, or hand to
anything that expects one.

Values include the usual scalars plus a few CASC-specific literals
([CASC.md §6](casc/CASC.md) has the full grammar). Each lands on the
closest native JS value, and on a small class from `@joetjen/cooper` only where
nothing native fits without losing information:

```casc
#@version = 1.0

name = "orders"
replicas = 3
order_id_max = 18446744073709551615
ratio = 0.75
limit = inf
debug = false
fallback = nil
level = info
timeout = 1h30m
max_body = 512MiB
released = 2024-03-01T12:00:00Z
cutoff = 2024-03-01
coordinates = (52.52, 13.405)
```

```js
import { loadStringSync } from '@joetjen/cooper';

const values = loadStringSync(source);
//=> {
//     name: 'orders',
//     replicas: 3,
//     order_id_max: 18446744073709551615n,
//     ratio: 0.75,
//     limit: Infinity,
//     debug: false,
//     fallback: null,
//     level: Symbol(info),
//     timeout: Duration(5400000000000ns),
//     max_body: ByteSize(536870912B),
//     released: 2024-03-01T12:00:00.000Z,
//     cutoff: LocalDate(2024-03-01),
//     coordinates: Tuple(2) [ 52.52, 13.405 ]
//   }
```

A few of those deserve a note:

- **Integers** are a `number` whenever they're safely representable,
  and a `bigint` beyond `Number.MAX_SAFE_INTEGER` — never a silently
  rounded `number`.
- **Atoms** (`info`, or `:info`) load as `Symbol.for(name)`, the
  closest JS analog to an Elixir atom; compare them with
  `values.level === Symbol.for('info')`, and get the name back with
  `Symbol.keyFor`. Like an atom, a registered symbol is never garbage
  collected — fine for config you control, worth knowing before you
  load config an untrusted party can write. Also note that
  `JSON.stringify` silently drops symbol values. `:nil`, `:true` and
  `:false` are not atoms but the values themselves (`null`, `true`,
  `false`), the same as on every CASC implementation.
- **Durations** and **byte sizes** come back as `Duration` and
  `ByteSize`, not bare numbers, so they're never confused with an
  ordinary number written in the same config. Both hold their base unit
  as a `bigint` (`.nanoseconds`, `.bytes`) and convert to plain numbers
  on request:

  ```js
  values.timeout.toMilliseconds();
  //=> 5400000
  values.timeout.toSeconds();
  //=> 5400
  values.max_body.toNumber();
  //=> 536870912
  ```

- **Datetimes** with an offset (`Z`, `+02:00`) are real instants and
  load as a `DateTime`, normalized to UTC: `1979-05-27T07:32:00.120+05:30`
  is `1979-05-27T02:02:00.120Z`. It keeps microseconds and the number of
  fraction digits written (`.120` stays `.120`), which a native `Date`
  can't; `toDate()` gives you one at millisecond resolution. Local ones
  (no offset) load as `LocalDateTime`, `LocalDate`, or `LocalTime`,
  since a `Date` would have to invent a time zone for them.
- **Tuples** load as a frozen `Tuple`, deliberately *not* an array,
  since CASC never merges or appends to a tuple (§8). It's iterable,
  has `.length` and `.at()`, and `toArray()` gives you a plain array.

IP addresses are a real data type, not just parsed text — `127.0.0.1`
loads as an `IPv4`, `::1` as an `IPv6`, both validated at load time (an
out-of-range octet or a CIDR prefix outside `0..32`/`0..128` is a
load-time error, never a crash later). Both support CIDR containment
and network math directly:

```casc
#@version = 1.0

allowed_networks = [10.0.0.0/8, 192.168.1.0/24]
```

```js
import { loadStringSync, IPv4 } from '@joetjen/cooper';

const config = loadStringSync(source);
const [office, vpn] = config.allowed_networks;
//=> [ IPv4(10.0.0.0/8), IPv4(192.168.1.0/24) ]
office.contains(IPv4.parse('10.1.2.3'));
//=> true
vpn.contains(IPv4.parse('10.1.2.3'));
//=> false
```

See the [cheatsheet](CHEATSHEET.md#ip-addresses-and-cidr) for the full
`IPv4`/`IPv6` API (`network()`, `broadcast()`, `firstHost()`,
`lastHost()`, `netmask()`).

## 3. Variables and interpolation

`@name = value` declares a variable. It isn't itself part of the
output tree — it's only useful for reference elsewhere via `@{name}`:

```casc
#@version = 1.0

@region = "eu-west"

endpoint = "https://api.@{region}.example.com"
```

```js
import { loadStringSync } from '@joetjen/cooper';

loadStringSync(source);
//=> { endpoint: 'https://api.eu-west.example.com' }
```

`@{name}` also works as a bare, whole value (`region = @{other_var}`),
not just embedded in a string. `@*name = value` declares a *private*
variable — usable within the file, but never inherited by whatever
imports it (§7).

## 4. Environment references

`${NAME}` reads an environment variable — from `process.env`, a `.env`
file (on by default; see §11), or the `env` option. Unlike `@{...}`, it
always resolves to a plain string — CASC never guesses that a string
"looks like" a number or boolean for you:

```casc
#@version = 1.0

region = ${REGION}
max_retries = !int(${MAX_RETRIES:3})
${?FEATURE_FLAG}
enabled = true
allowed_hosts = ${ALLOWED_HOSTS[]:["localhost"]}
```

With `REGION=eu-west` set and everything else unset:

```js
import { loadStringSync } from '@joetjen/cooper';

loadStringSync(source, { env: { REGION: 'eu-west' } });
//=> { region: 'eu-west', max_retries: 3, allowed_hosts: [ 'localhost' ] }
```

A few things happened there:

- `${NAME:default}` falls back to `default` — parsed as an ordinary
  CASC value, so a bare `3` really is the number `3`, not `'3'`.
- `!int(...)` is a **tagged value**: it wraps whatever's inside
  (typically a `${...}` read, since that's always a string) and
  converts it. `!int`, `!float`, `!bool`, `!duration`, and `!bytes`
  are built in, alongside a few more (see the
  [cheatsheet](CHEATSHEET.md#built-in-tags)); register your own via the
  `tags` option (CASC.md §7.5; see [§10](#10-putting-it-together) for
  `resolvers`, the analogous option for `!{resolver:payload}`). A tag
  of your own receives a float as a `CooperFloat`, nested ones too, so
  it can tell `!twice(2.0)` from `!twice(2)`:

  ```js
  import { CooperFloat } from '@joetjen/cooper';

  const tags = {
    twice: (n) => {
      if (n instanceof CooperFloat) return new CooperFloat(n.value * 2); // stays a float
      if (Number.isInteger(n)) return n * 2;
      throw new Error(`cannot double ${n}`);
    },
  };
  ```

  The loaded config itself holds plain numbers, as everywhere else.
- `${?FEATURE_FLAG}` guards the *one statement that follows it* — with
  `FEATURE_FLAG` unset, `enabled = true` is skipped entirely (not
  evaluated-then-discarded — nothing inside a skipped statement can
  throw just because it happened to be skipped). See
  [§13](#13-guards) for the full treatment.
- `${NAME[]:default}` parses a set env var as a comma-separated list.

## 5. Secrets

Prefixing any key segment with `*` marks it (and everything under it)
secret. Secret values load normally, but come back wrapped in `Secret`,
which redacts itself everywhere it might be displayed:

```casc
#@version = 1.0

database {
  *password = ${DB_PASSWORD}
  host = "db.internal"
}

url = "postgres://%{database.host}?password=%{database.password}"
```

```js
import { loadStringSync, Secret } from '@joetjen/cooper';

const config = loadStringSync(source, { env: { DB_PASSWORD: 'hunter2' } });
//=> {
//     database: { password: [~~REDACTED~~], host: 'db.internal' },
//     url: 'postgres://db.internal?password=[~~REDACTED~~]'
//   }
`connecting with ${config.database.password}`;
//=> 'connecting with [~~REDACTED~~]'
JSON.stringify(config.database);
//=> '{"password":"[~~REDACTED~~]","host":"db.internal"}'
config.database.password.reveal();
//=> 'hunter2'
```

`util.inspect`/`console.log`, `String()`, template literals, and
`JSON.stringify` all redact unconditionally — there's no "debug mode"
flag to accidentally leave on in production. The only ways to the real
value are `secret.reveal()`, the static `Secret.reveal(x)` (which also
passes a non-secret `x` through unchanged — handy for code that accepts
either), or the `value` property, which makes "did I accidentally log a
secret" something you can grep for, not a runtime toggle you have to
trust everyone remembered to check. `value` is also non-enumerable, so
object spread, `Object.keys`, and logging libraries that walk an
object's own keys don't copy it out either:

```js
({ ...config.database.password });
//=> { redacted: null }
```

The wrapping travels with the value, not just the key it was declared
at — a `%{...}` reference or a `for ... from` template that copies a
secret value somewhere else copies the wrapping right along with it, so
there's no path in the tree where the same underlying secret shows up
unprotected. And a secret embedded inside a *larger* interpolated
string (`url` above) only redacts its own portion, not the whole
string — each secret at its own position, if there are several:

```js
config.url instanceof Secret;
//=> true
String(config.url);
//=> 'postgres://db.internal?password=[~~REDACTED~~]'
Secret.reveal(config.url);
//=> 'postgres://db.internal?password=hunter2'
```

## 6. Errors

Every stage of loading can fail, and every failure is a `CooperError` —
thrown by the `*Sync` functions, the rejection reason of the async ones.
`err.stage` tells you roughly where things went wrong (`lexer`,
`parser`, `action`, `loop`, `import`, `merge`, `resolve`, `dotenv`)
alongside a human-readable `err.message`:

```js
import { loadString, CooperError } from '@joetjen/cooper';

try {
  await loadString('#@version = 1.0\nvalue = !{missing:x}');
} catch (err) {
  err instanceof CooperError;
  //=> true
  [err.stage, err.message];
  //=> [ 'resolve', 'unregistered resolver "missing"' ]
}
```

A syntax error also carries `err.line` and `err.column` (1-based), and
`err.file` when the source came from a file:

```js
import { loadStringSync } from '@joetjen/cooper';

try {
  loadStringSync('#@version = 1.0\nserver {\n  port = = 8080\n}');
} catch (err) {
  [err.stage, err.line, err.column];
  //=> [ 'parser', 3, 10 ]
}
```

Unregistered resolvers, unregistered tags, unregistered import
schemes, a `%{...}` reference cycle, and a mismatched-length loop
binding are all load-time errors naming the offender specifically —
`cooper` never silently drops a reference or guesses at intent. When
one of your own resolvers or tags throws, the `CooperError` names it
and keeps your original error as `err.cause`.

## 7. Imports and test-time injection

`import "path/to/file.casc"` splices another file's own statements in
at that point — later statements (including the importer's own,
following the import) override earlier ones at the same path, and any
*public* `@name` variable the imported file declares becomes visible
to the importer too:

```casc
# defaults.casc
#@version = 1.0

@region = "eu-west"

server {
  host = "0.0.0.0"
  port = 8080
}
```

```casc
# app.casc
#@version = 1.0

import "defaults.casc"

server.port = 9090
endpoint = "https://api.@{region}.example.com"
```

```js
import { loadFile } from '@joetjen/cooper';

await loadFile('app.casc');
//=> {
//     server: { host: '0.0.0.0', port: 9090 },
//     endpoint: 'https://api.eu-west.example.com'
//   }
```

`loadFile` resolves a relative import against the loaded file's own
directory automatically; `loadString` resolves it against the `root`
option, which defaults to `process.cwd()`.

You can also register your own `scheme://` import loader, and resolver
and tag functions — this is what makes it practical to unit-test config
that imports from, say, a secrets manager or a config service, without
touching the filesystem or making a real network call:

```casc
#@version = 1.0

import "mem://extra"

app_name = "orders"
```

```js
import { loadString } from '@joetjen/cooper';

const importSchemes = {
  mem: async (rest) => '#@version = 1.0\nregion = "eu-west"',
};

await loadString(source, { importSchemes });
//=> { region: 'eu-west', app_name: 'orders' }
```

A loader receives everything after `scheme://` and returns CASC source
text, directly or as a `Promise` (async loaders need the async API, §1).
`resolvers`/`tags` work the same way — in-memory stand-ins for whatever
a real resolver would call out to, with no global state to set up or
tear down.

`env` (most examples in this tutorial already use it) is a little
different: it's an **override**, not a replacement — see §11 for why
`env: { REGION: 'eu-west' }` guarantees `REGION` specifically but
doesn't isolate a test from `process.env` or any `.env` file on disk
the way `resolvers`/`importSchemes` do. Give every name a test needs a
deterministic value its own explicit `env` entry, rather than relying
on it being otherwise unset.

## 8. Merge control and loops

Later statements override earlier ones at the same path, and objects
deep-merge by default. A leading sigil on a key changes that:

```casc
#@version = 1.0

server { host = "0.0.0.0", port = 8080, tls { min_version = "1.2" } }
~server { port = 9090 }

tags = ["a", "b", "c"]
+tags = ["d"]
-tags = ["b"]
```

```js
import { loadStringSync } from '@joetjen/cooper';

loadStringSync(source);
//=> { server: { port: 9090 }, tags: [ 'a', 'c', 'd' ] }
```

`~key { ... }` replaces the *entire* subtree at `key`, not just the
fields the new block mentions — `host` and `tls` are gone, not merged.
`+`/`-` append/remove list elements by value. Tuples (CASC.md §6.11)
are never merged at all — only replaced wholesale — since `cooper` has
no schema to know which position means what.

`for` loops generate many entries from one template:

```casc
#@version = 1.0

defaults.replica {
  cpu = 1
  memory_mb = 512
}

@instances = ["a", "b", "c"]
for @instance in @{instances} from defaults.replica as replicas."@{instance}" {
  cpu = 2
}
```

```js
import { loadStringSync } from '@joetjen/cooper';

loadStringSync(source);
//=> {
//     defaults: { replica: { cpu: 1, memory_mb: 512 } },
//     replicas: {
//       a: { cpu: 2, memory_mb: 512 },
//       b: { cpu: 2, memory_mb: 512 },
//       c: { cpu: 2, memory_mb: 512 }
//     }
//   }
```

Each generated `replicas.<instance>` starts as a copy of
`defaults.replica` (`from`, resolved lazily against the *final* merged
tree — it doesn't matter whether `defaults.replica` is written before
or after the loop), with the loop body layered on top as overrides.
See [CASC.md §5.5](casc/CASC.md) for parallel (zipped) multi-binding
loops and index bindings.

## 9. Config references

`%{path}` refers to another value in the *same, fully-merged* tree —
resolved lazily, after every import and merge, so it always sees the
final value regardless of where in the file (or which imported file)
the reference itself was written:

```casc
#@version = 1.0

server.host = "api.internal"
server.port = 8080
health_check.url = "http://%{server.host}:%{server.port}/health"
admin_email = %{contact.admin:"ops@example.com"}
```

```js
import { loadStringSync } from '@joetjen/cooper';

loadStringSync(source);
//=> {
//     server: { host: 'api.internal', port: 8080 },
//     health_check: { url: 'http://api.internal:8080/health' },
//     admin_email: 'ops@example.com'
//   }
```

A `%{...}` cycle (directly or transitively referencing itself) is a
load-time error naming the full cycle path — never an infinite loop or
a silently partial value.

## 10. Putting it together

Everything above composes into one file and one call:

```casc
# config.casc
#@version = 1.0

@region = ${REGION:"eu-west"}

server {
  host = "0.0.0.0"
  port = !int(${PORT:8080})
}

database {
  *password = !{vault:secret/db/password}
  host = "db.@{region}.internal"
  timeout = 500ms
}

endpoints.health = "http://%{server.host}:%{server.port}/health"
```

A resolver receives the text after the colon and returns the value —
or, with the async API, a `Promise` of it. Throw (or reject) to fail
the load:

```js
import { loadFile, CooperError } from '@joetjen/cooper';

// Stands in for your secrets manager's client.
const vault = {
  async read(path) {
    if (path === 'secret/db/password') return 's3cr3t';
    throw new Error(`no secret at ${path}`);
  },
};

async function loadConfig() {
  try {
    return await loadFile('config.casc', {
      resolvers: { vault: (path) => vault.read(path) },
    });
  } catch (err) {
    if (err instanceof CooperError) throw new Error(`invalid config: ${err.message}`, { cause: err });
    throw err;
  }
}

const config = await loadConfig();
//=> {
//     server: { host: '0.0.0.0', port: 8080 },
//     database: {
//       password: [~~REDACTED~~],
//       host: 'db.eu-west.internal',
//       timeout: Duration(500000000ns)
//     },
//     endpoints: { health: 'http://0.0.0.0:8080/health' }
//   }
config.database.timeout.toMilliseconds();
//=> 500
```

`resolvers` and `tags` also accept a `Map`, if that's what you already
have.

## 11. .env files

By default, `${...}` resolution layers in `.env` files from the project
root — the directory of the nearest `package.json` above the working
directory, else the working directory itself; never the directory of
the config file being loaded. A process started from a subdirectory (a
test runner, a script under `bin/`) still finds them. `dotenvDir` names
another directory, and is the base a relative `dotenvFiles` entry
resolves against. No option is needed. The full chain, later winning:

1. `.env`
2. `.env.<env>` — `<env>` is the `dotenvEnv` option, else
   `COOPER_ENV` as `process.env`, the `env` option and `.env` set it
   (falling back to `NODE_ENV` by its shared name, else `dev`): so
   `.env.dev`, `.env.staging`, `.env.test` or `.env.prod`, the names
   every Cooper reads. `NODE_ENV=production` reads `.env.prod`, not
   `.env.production`. `dotenvEnv: null` skips this layer
3. `.env.local` — a personal, usually-gitignored override
4. `process.env` — the real environment, outranking every file
5. the `env` option, if passed — always the final, highest-precedence
   override

A missing file (1-3) is never an error — `.env.<env>` in particular is
expected to be absent for every environment but the current one.

```casc
# config.casc
#@version = 1.0

region = ${REGION}
log_level = ${LOG_LEVEL:"info"}
```

```dotenv
# .env
REGION=eu-west
```

```dotenv
# .env.prod
LOG_LEVEL=warning
```

```js
import { loadFileSync } from '@joetjen/cooper';

loadFileSync('config.casc');
//=> { region: 'eu-west', log_level: 'info' }
loadFileSync('config.casc', { env: { COOPER_ENV: 'prod' } });
//=> { region: 'eu-west', log_level: 'warning' }
```

**The real environment wins over the files.** A deployment sets
variables in the environment it controls, and a file in the working
directory must not silently beat them — the same choice the `dotenv`
packages for Node and Ruby make by default. If you want the opposite
locally, to shadow something exported in your shell, pass
`dotenvOverride: true`:

```js
process.env.REGION = 'us-east';

loadFileSync('config.casc').region;
//=> 'us-east'
loadFileSync('config.casc', { dotenvOverride: true }).region;
//=> 'eu-west'
```

**`env` overrides, it doesn't isolate.** `env: { REGION: 'ap-south' }`
guarantees `REGION` resolves to `'ap-south'` — but any `${...}`
reference to a name *not* in that object still falls through to
`.env`/`.env.local`/`process.env`, same as if `env` weren't passed at
all:

```js
loadFileSync('config.casc', { env: { REGION: 'ap-south' }, dotenvEnv: 'production' });
//=> { region: 'ap-south', log_level: 'warning' }
```

`dotenv: false` disables just the `.env` file layers (1-3) —
`process.env` and `env` still apply either way. `dotenvFiles` fully
replaces the default three-file list, for a non-standard layout.

The `.env` parser is built in — no extra dependency to install. It
reads the same format as the Elixir version's `dotenvy`: `KEY=value`
lines with an optional `export ` prefix, `#` comments, `'single'`
(literal) and `"double"` (escapes) quoted values, `'''`/`"""` multi-line
values, and `${NAME}` interpolation of anything defined in an earlier
layer or earlier in the same file. One deliberate omission: `$(command)`
is kept as literal text, never executed — loading configuration should
never run programs. A malformed `.env` file is a `CooperError` with
stage `dotenv`. `Dotenv.env(opts)` returns the merged environment a
load with those options would see, and `Dotenv.parse(text)` parses one
file's contents, if you want either on its own.

## 12. Caching

`loadFile`/`loadFileSync` cache everything up to the final
`${...}`-resolution step *by default*, reusing it across calls as long
as every file that contributed to it — the entry file, plus every
transitively imported file — still has the modification time it had
when the cache entry was populated, and every import pattern
(`import "parts/*.casc"`) still matches the same files. A file added
where a glob import looks is read on the next load:

```casc
# config.casc
#@version = 1.0

port = !int(${PORT:8080})
```

```js
import { loadFile, Cache } from '@joetjen/cooper';

await loadFile('config.casc');
//=> { port: 8080 }
Cache.size();
//=> 1
```

`${...}` resolution itself is never cached — it re-runs against a
freshly computed environment (`.env` files included) on *every* call,
hit or miss, so an ordinary `${NAME}` value is always current
regardless of whether the surrounding tree came from the cache:

```js
process.env.PORT = '9090';

await loadFile('config.casc');
//=> { port: 9090 }
```

Pass `cache: false` to bypass the cache entirely for one call — a full
reparse every time, for forcing a guaranteed-fresh read, or in tests.
`Cache.invalidate(path)` and `Cache.clear()` drop a specific entry or
everything, for anywhere you need to force a reload without waiting for
a file-change check. `loadString` never caches, since there's no file to
key an entry on.

The cache is keyed by file path and `root` only. A call that passes
different `importSchemes`, `resolvers`, or `tags` for the same file than
an earlier call should pass `cache: false`.

**One real limitation, not a bug**: a `${?NAME}` guard's decision is
baked in at the moment the cache entry is populated — it's decided
while the file is evaluated, long before the always-fresh
`${...}`-resolution step runs — so it only refreshes when the entry
itself is invalidated (a fingerprinted file changes, the `watchEnv`
poll below notices the name changed, or an explicit
`Cache.invalidate()`/`Cache.clear()`), not on every call the way an
ordinary value read is. See [§13](#13-guards) for guards specifically.

### Getting notified of changes

`loadFile` publishes to two
[`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html)
channels — Node's built-in, zero-cost-when-unused analog of the Elixir
version's `:telemetry` events. Subscribe the ordinary way:

```js
import diagnostics from 'node:diagnostics_channel';
import fs from 'node:fs';
import path from 'node:path';

const fileChanges = [];
diagnostics.subscribe('cooper:cache:file_changed', (msg) => {
  fileChanges.push(msg.changedFiles.map((file) => path.basename(file)));
});

fs.writeFileSync('config.casc', '#@version = 1.0\n\nport = !int(${PORT:8080})\nworkers = 4\n');

await loadFile('config.casc');
//=> { port: 9090, workers: 4 }
fileChanges;
//=> [ [ 'config.casc' ] ]
```

`cooper:cache:file_changed` fires whenever a *previously cached*
entry's fingerprint no longer matches disk — never on the first load of
a file, since nothing "changed" yet at that point. Message: `{ path,
root, changedFiles, systemTime }` (absolute paths, and a `Date.now()`
timestamp). It's published from inside the `loadFile` call that
noticed the change.

`cooper:cache:env_changed` needs no call at all. `watchEnv` defaults to
on for any load that reads `${...}` (an ordinary value, a guard, or
both), and off for one that doesn't; pass `watchEnv: true`/`false` to
override either way. Only the `${NAME}`s the load *actually read* are
watched — not the whole environment — and they're compared against
`Dotenv.env(...)`, so an assignment to `process.env` and a `.env` file
edit both count as the same kind of change, with no separate file
watching needed for the latter. There's no OS-level notification for
either, so this is a poll on a timer (every 5 seconds by default; set
it with `Cache.configure({ pollInterval })`, in milliseconds), not
pushed live. The timer is unref'd, so it never keeps your process
alive, and it stops once nothing is watched. When it does see a change,
it drops the cache entry too, so the next `loadFile` re-reads the file
against the current environment:

```js
import { setTimeout as sleep } from 'node:timers/promises';

const envChanges = [];
diagnostics.subscribe('cooper:cache:env_changed', (msg) => envChanges.push(msg.changedNames));
Cache.configure({ pollInterval: 100 });

await loadFile('config.casc');
process.env.PORT = '7070';
await sleep(300);

envChanges;
//=> [ [ 'PORT' ] ]
```

Message: `{ path, root, changedNames, systemTime }`. An environment
change made *outside* the running process (another shell, a systemd
unit file) is never observable at all, by `cooper` or anything else —
a process's environment is a snapshot taken when it starts; only
`process.env` assignments made inside that same process (or a `.env`
file the poll re-reads) can ever change what it sees.

## 13. Guards

`${?NAME}` (CASC.md §7.2) guards the *one* statement immediately after
it — write them on the same line:

```casc
#@version = 1.0

${?FEATURE_FLAG} beta_enabled = true
log_level = info
```

With `FEATURE_FLAG` unset (or set to an empty string — CASC treats
those the same), `beta_enabled` is skipped entirely and doesn't appear
in the result at all:

```js
import { loadStringSync } from '@joetjen/cooper';

loadStringSync(source, { env: { FEATURE_FLAG: '' } });
//=> { log_level: Symbol(info) }
loadStringSync(source, { env: { FEATURE_FLAG: '1' } });
//=> { beta_enabled: true, log_level: Symbol(info) }
```

A guarded statement is never *evaluated-then-discarded* the way a
`#`-disabled one is — nothing inside it (an unregistered tag, an
undefined variable, whatever) can throw just because it happened to be
skipped, since it's never touched at all when the guard doesn't pass.
Only the statement directly after the guard is covered — an ordinary
statement on the next line is unaffected, guard or not:

```casc
#@version = 1.0

${?MAYBE} guarded = !not_registered(@{undefined_variable})
kept = 1
```

```js
loadStringSync(source, { env: { MAYBE: '' } });
//=> { kept: 1 }
```

A guard can wrap any statement — a block, a `for` loop, an import —
not just a plain assignment:

```casc
#@version = 1.0

${?ENABLE_METRICS} metrics { port = 9090, path = "/metrics" }
```

```js
loadStringSync(source, { env: { ENABLE_METRICS: 'true' } });
//=> { metrics: { port: 9090, path: '/metrics' } }
```

**Guards and caching**: `loadFile` caches the evaluated tree by default
(§12), and a guard's decision is part of what gets cached — it doesn't
re-evaluate on every call the way an ordinary `${...}` value does.
`watchEnv` defaults to on for any file that references the environment
at all, guards included, so a guard's variable flipping is detected
(and the cache entry dropped) by the next poll — see §12's "Getting
notified of changes". If your code flips a guard's variable and needs
the very next load to see it, call `Cache.invalidate(path)` first (or
load with `cache: false`).

## 14. Modules

A config sometimes chooses code: which payment client, which log
formatter. `!module("Name")` names a module, written the same way for
every Cooper implementation — dot-separated PascalCase:

```casc
#@version = 1.0

payments.client = !module(${PAYMENTS_CLIENT:"Acme.Payments.StripeClient"})
```

A Node module is a location, not a name, so you tell `cooper` where each
name lives with the `modules` option. A string is a module specifier (a
relative one resolves against `process.cwd()`, because the mapping is your
application's code, not the config's); anything else is the module itself:

```js
import { Fake } from './test/fake-payments.js';

const config = loadStringSync(source, {
  modules: {
    'Acme.Payments.StripeClient': './lib/payments/stripe.js',
    'Acme.Payments.Fake': Fake,
  },
});
//=> { payments: { client: ModuleRef(Acme.Payments.StripeClient) } }
const { default: Client } = await config.payments.client.load();
```

Nothing is imported while the config loads; `load()` imports the
specifier when you ask (or hands back the module you mapped). A name
that isn't PascalCase (`stripe_client`, `./x.js`) or that `modules`
doesn't hold is a `resolve`-stage `CooperError`, so a typo in
`PAYMENTS_CLIENT` fails at startup.

From here, [CASC.md](casc/CASC.md) is the full reference for anything
this tutorial only touched briefly, the [examples](EXAMPLES.md) show
`cooper` in more realistic settings, and the
[cheatsheet](CHEATSHEET.md) is a fast lookup for `cooper`'s own public
API.
