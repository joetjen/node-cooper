# Cheatsheet

Quick reference for `cooper`'s public API. See the
[tutorial](TUTORIAL.md) for a walkthrough, or [CASC.md](casc/CASC.md)
for the full language reference. In the runnable snippets, `//=>`
shows the value as `util.inspect(value, { depth: null })` prints it.

## Load config

```ts
loadFile(path: string, opts?: LoadOptions): Promise<object>      // rejects with CooperError
loadString(source: string, opts?: LoadOptions): Promise<object>  // rejects with CooperError
loadFileSync(path: string, opts?: LoadOptions): object           // throws CooperError
loadStringSync(source: string, opts?: LoadOptions): object       // throws CooperError
```

```js
import { loadFile, loadFileSync, loadString, loadStringSync } from 'cooper';
// or: const { loadFile, ... } = require('cooper');

loadStringSync('#@version = 1.0\nport = 8080');
//=> { port: 8080 }
```

`loadFile` reads `path` and derives `root` (bare imports resolve against
the file's directory) and import-cycle detection from it automatically —
the ordinary way to load a real file. Caches by default (see
[Caching](#caching) below); pass `cache: false` to opt out for one call.
`loadString` is for source that isn't (yet, or ever) in a file — bare
imports resolve against `root`, default `process.cwd()`; never caches.

## Sync or async

| | Use when |
|---|---|
| `loadFileSync` / `loadStringSync` | Every resolver, tag, and import-scheme loader you register returns its value directly. Plain files at startup, CommonJS top level. |
| `loadFile` / `loadString` | Any of them returns a `Promise` (a secrets manager, a remote config service). Also fine when they don't. |

Same pipeline, same result. A callback that returns a `Promise` under
the `*Sync` API fails the load with a `CooperError` saying to use the
async API.

## Options

| Option | Shape | Default | Effect |
|---|---|---|---|
| `env` | `Record<string, string>` | `{}` | **Override**, not replacement, for `${...}` resolution — always wins for a name it defines, but a name it doesn't define still falls through to `.env`/`process.env` (see [.env files](#env-files)). |
| `dotenv` | `boolean` | `true` | Layer `.env` file(s) *under* `process.env` (see [.env files](#env-files)). `false` disables just the file layers. |
| `dotenvEnv` | `string \| null` | `COOPER_ENV` (real env, `env`, then `.env`) | Which `.env.<env>` file to read -- `.env.dev`, `.env.prod`, ..., never `.env.production`; `null` skips that layer. |
| `dotenvFiles` | `string[]` | `['.env', '.env.<dotenvEnv>', '.env.local']` | Fully replaces the default `.env` file list. A relative entry resolves against `dotenvDir`; an absolute one is used as is. |
| `dotenvDir` | `string` | the project root: the nearest `package.json` above `process.cwd()`, else `process.cwd()` | The directory `.env` files are read from (`Dotenv.projectRoot()` gives the default). |
| `dotenvOverride` | `boolean` | `false` | Put the `.env` files *above* `process.env` instead. |
| `root` | `string` | the file's directory (`loadFile`) / `process.cwd()` (`loadString`) | Where a bare `import "..."` resolves. |
| `file` | `string` | — | `loadString` only: the path the source came from, for private-variable scoping and import-cycle detection. |
| `resolvers` | `Record<string, (payload: string) => any>` or a `Map` | `{}` | One function per `!{name:payload}` (CASC.md §7.4). Return the value (or a `Promise` of it, async API); throw to fail. Unregistered use is a load-time error. |
| `tags` | `Record<string, (arg: any) => any>` or a `Map` | `{}` | One function per `!name(arg)` (CASC.md §7.5). Same contract as `resolvers`. A same-named entry replaces a built-in. Unregistered use is a load-time error. A float in the argument, nested ones included, arrives as a `CooperFloat` (`.value`, `toNumber()`, arithmetic works; `String()` is `2.0`), an integer as a `number`/`bigint`; return a `CooperFloat` to yield a float. |
| `importSchemes` | `Record<string, (rest: string) => string \| Promise<string>>` | `{}` | One loader per `import "scheme://rest"` (CASC.md §5.1), returning CASC source text. Unregistered use is a load-time error. |
| `modules` | `Record<string, string \| any>` or a `Map` | `{}` | What each `!module("Name")` means (CASC.md §7.5), by the name exactly as written. A string is a module specifier, a relative one resolved against `process.cwd()`; any other value is the module itself. A name it does not hold is a load-time error. See [Built-in tags](#built-in-tags). |
| `cache` | `boolean` | `true` | `loadFile`/`loadFileSync` only. `false` bypasses the cache for that call (see [Caching](#caching)). |
| `watchEnv` | `boolean` | whether the load read any `${...}` | `loadFile`/`loadFileSync` only. Polls every `${NAME}` the load read for changes (see [Caching](#caching)). |

## Values

| CASC (CASC.md §6) | JS |
|---|---|
| `"text"`, `'text'`, heredocs | `string` |
| `42`, `0x1F`, `1_000` | `number` when safe, `bigint` beyond `Number.MAX_SAFE_INTEGER` |
| `1.5`, `inf`, `-inf` | `number` (`Infinity`, `-Infinity`); a `CooperFloat` when handed to a tag you register |
| `true` / `false`, `nil` (also `:true` / `:false`, `:nil`) | `boolean`, `null` |
| `info`, `:info` (atom) | `Symbol.for('info')` — dropped by `JSON.stringify` |
| `[1, 2]` | `Array` |
| `{ ... }` block / dotted keys | plain object, string keys |
| `(52.52, 13.405)` | `Tuple` — frozen, iterable, `.length`, `.at(i)`, `toArray()`, `Tuple.of(...)` |
| `500ms`, `1h30m` | `Duration` — `.nanoseconds` (`bigint`), `toMilliseconds()`, `toSeconds()`, `Duration.parse()`, `fromMilliseconds()`, `fromSeconds()` |
| `512MiB`, `10GB` | `ByteSize` — `.bytes` (`bigint`), `toNumber()`, `ByteSize.parse()`, `fromNumber()` |
| `1979-05-27T07:32:00Z`, `...+02:00` | `DateTime` — UTC, microsecond resolution, keeps the fraction digits written (`.120`); `toDate()` / `fromDate()`, `DateTime.parse()` |
| `1979-05-27T07:32:00` | `LocalDateTime` — `toDate()` / `fromDate()` (local time zone) |
| `1979-05-27` | `LocalDate` — `toDate()` / `fromDate()` (local midnight) |
| `07:32:00` | `LocalTime` |
| `10.0.0.0/8`, `::1` | `IPv4`, `IPv6` (see [below](#ip-addresses-and-cidr)) |
| `*key = ...` | `Secret` around the value (see [Secrets](#secrets)) |
| `!module("Acme.Payments")` | `ModuleRef` (see [Built-in tags](#built-in-tags)) |

Every class has `equals(other)`, a `toString()` that renders back to
CASC literal syntax (`Duration` and `ByteSize` in their base unit,
`"500000000ns"`/`"536870912B"`), and a `toJSON()`, so
`JSON.stringify(config)` works — except on a `bigint` integer, which
`JSON.stringify` refuses outright.

```js
import { Duration, ByteSize, IPv4 } from 'cooper';

Duration.parse('1h30m').toSeconds();
//=> 5400
ByteSize.parse('512MiB').toNumber();
//=> 536870912
JSON.stringify({ timeout: Duration.parse('500ms'), ip: IPv4.parse('10.0.0.1') });
//=> '{"timeout":"500000000ns","ip":"10.0.0.1"}'
```

## Guards

```casc
${?NAME} statement
```

Guards the *one* statement immediately after it (same line) —
`statement` is skipped entirely (never evaluated, not
evaluated-then-discarded) when `NAME` is unset or empty. See the
[tutorial](TUTORIAL.md#13-guards) for the full walkthrough, including
caching/`watchEnv` interaction.

## .env files

On by default. Layers, later winning:

```text
.env < .env.<dotenvEnv> < .env.local < process.env < env option
```

`.env`/`.env.<dotenvEnv>`/`.env.local` are optional — missing is never
an error — and are read from `dotenvDir` (default: the project root,
the nearest `package.json` above `process.cwd()`), not the config file's
directory. `env`, if passed, always wins for the names it defines, but
doesn't isolate resolution from anything below it — a name not in `env`
still falls through to `.env`/`process.env`. The parser is built in (no
dependency) and reads dotenvy's format; `$(command)` stays literal text,
never executed. See the [tutorial](TUTORIAL.md#11-env-files) for the
full walkthrough.

`${COOPER_ENV}` is always defined (CASC.md §7.2): a non-empty
`COOPER_ENV` from any layer wins; otherwise `NODE_ENV` from the same
layers, mapped onto the shared names (`development`/`local` -> `dev`,
`testing` -> `test`, `production` -> `prod`, anything else unchanged;
exact and case-sensitive; a real `COOPER_ENV` is never mapped);
otherwise `"dev"`. The `watchEnv` poll sees the fallback, so a changed
`NODE_ENV` reads as a changed `COOPER_ENV`.

```ts
Dotenv.env(opts?): Record<string, string>                       // the merged env a load with `opts` sees
Dotenv.parse(text: string, vars?: Record<string, string>): Record<string, string>  // one file's contents
```

## Caching

```ts
Cache.invalidate(path: string): void     // drop every entry for `path`
Cache.clear(): void                      // drop everything, stop polling
Cache.size(): number                     // number of cached entries
Cache.configure({ pollInterval }): void  // watchEnv poll interval in ms (default 5000)
Cache.CHANNEL_FILE_CHANGED               // 'cooper:cache:file_changed'
Cache.CHANNEL_ENV_CHANGED                // 'cooper:cache:env_changed'
```

`loadFile`/`loadFileSync` cache everything up to `${...}` resolution by
default, keyed by path and `root`, and invalidated by modification time
(entry file + every transitively imported file) and by what each import
pattern matches (a file added where a glob looks). `${...}` itself always
re-runs fresh, hit or miss. `cache: false` bypasses the cache for one
call — also pass it when calls for the same file vary `resolvers`,
`tags`, or `importSchemes`. A `${?NAME}` guard's decision is baked in at
populate time, refreshed only when the entry invalidates — not per
call, unlike an ordinary value read. See the
[tutorial](TUTORIAL.md#12-caching) for the full walkthrough.

**Diagnostics channels** (`node:diagnostics_channel`), free with no
subscribers:

| Channel | Message | Published |
|---|---|---|
| `cooper:cache:file_changed` | `{ path, root, changedFiles, systemTime }` | By the `loadFile` call that finds a cached entry's fingerprint no longer matches disk. Never on first load. |
| `cooper:cache:env_changed` | `{ path, root, changedNames, systemTime }` | By the `watchEnv` poll (on by default for any load reading `${...}`), when a `${NAME}` the load read has changed — via `process.env` or a `.env` edit. The entry is dropped too. A change made outside the process is never observable. |

```js
import diagnostics from 'node:diagnostics_channel';
import { Cache } from 'cooper';

diagnostics.subscribe(Cache.CHANNEL_ENV_CHANGED, ({ path, changedNames }) => {
  // reload `path`
});
```

## Built-in tags

`!int(arg)`, `!float(arg)`, `!bool(arg)`, `!duration(arg)`,
`!bytes(arg)`, `!trim(arg)`, `!downcase(arg)`, `!upcase(arg)`,
`!module(arg)` — always registered, need no `tags` entry.
`!duration(...)` and a bare duration literal (`500ms`) both produce a
`Duration`; `!bytes(...)` and a bare byte-size literal (`512MiB`) both
produce a `ByteSize`.

`!module("Name")` takes a module name written the same way for every
Cooper implementation: dot-separated PascalCase (`Acme.Payments.StripeClient`,
`ASCO.HTTPClient`), surrounding whitespace ignored, at most 512 bytes.
Anything else — `crypto`, `Foo.bar`, `Foo_Bar`, `./x.js`, `node:fs` — is a
`resolve`-stage error, even if `modules` holds it. A Node module is a
location, not a name, so the name must be in the `modules` option (looked
up exactly as written, case included); a name it does not hold is a
`resolve`-stage error naming the module and the option. The result is a
`ModuleRef`. Nothing is imported at load time:

```ts
ref.name           // the name as written in the config
ref.specifier      // what load() imports, when modules held a string (a relative one is absolute against process.cwd())
ref.value          // the module itself, when modules held anything else
ref.load()         // Promise: import(specifier), or value as is
```

```js
import { loadStringSync } from 'cooper';
import { Stripe } from './lib/payments/stripe.js';

const config = loadStringSync(`#@version = 1.0
port = !int(\${PORT:"8080"})
name = !upcase(!trim("  orders "))
hash = !module("Crypto")
payments = !module("Acme.Payments.StripeClient")
`, { modules: { Crypto: 'node:crypto', 'Acme.Payments.StripeClient': Stripe } });
//=> { port: 8080, name: 'ORDERS', hash: ModuleRef(Crypto), payments: ModuleRef(Acme.Payments.StripeClient) }
typeof (await config.hash.load()).createHash;
//=> 'function'
(await config.payments.load()) === Stripe;
//=> true
```

## IP addresses and CIDR

A bare `127.0.0.1`/`127.0.0.1/32` (CASC.md §6.7) literal loads as an
`IPv4`; `::1`/`::1/128` as an `IPv6`. Both are validated at load time —
an out-of-range octet, a malformed address, or a CIDR prefix outside
`0..32`/`0..128` is a load-time error, not a crash or a silently
accepted value.

```ts
new IPv4(address: number[4], prefix?: number | null)  // throws RangeError on bad input
IPv4.parse(text: string): IPv4                         // '10.0.0.1' or '10.0.0.0/8'
ip.address                // frozen array of octets
ip.prefix                 // 0..32, or null for a plain address
ip.contains(other)        // is `other` inside this block?
ip.network()              // the block's network address
ip.broadcast()            // the block's broadcast address (IPv4 only)
ip.netmask()              // the netmask implied by the prefix
ip.firstHost()            // first usable host address
ip.lastHost()             // last usable host address
```

`IPv6` has the identical API (eight 16-bit groups) minus `broadcast()`.
Both render back in CASC's literal syntax via `toString()`/`toJSON()`,
including when interpolated into a string.

```js
import { IPv4, IPv6 } from 'cooper';

const block = IPv4.parse('192.168.1.0/24');
[block.network(), block.broadcast(), block.netmask(), block.firstHost(), block.lastHost()];
//=> [
//     IPv4(192.168.1.0/24),
//     IPv4(192.168.1.255/24),
//     IPv4(255.255.255.0),
//     IPv4(192.168.1.1),
//     IPv4(192.168.1.254)
//   ]
IPv6.parse('2001:db8::/32').contains(IPv6.parse('2001:db8::1'));
//=> true
```

## Secrets

```ts
secret.reveal()            // the real, fully unmasked value
Secret.reveal(x)           // same, and passes a non-Secret `x` through unchanged
secret.value               // the real value too (non-enumerable)
secret.redacted            // display text for a partially redacted string, or null
```

Any key segment prefixed with `*` (`*key`, CASC.md §4.3) comes back
wrapped in `Secret`. `util.inspect`/`console.log`, `String()`, template
literals, and `JSON.stringify` redact unconditionally — `reveal()` (or
`value`) is the only way to the real value. `value` is non-enumerable,
so spread/`Object.keys`/`structuredClone` don't copy it out.

- **Whole-value secret** (`*password = "..."`) — `redacted` is `null`;
  it displays as the blanket `[~~REDACTED~~]` marker.
- **Secret embedded in a larger interpolated string**
  (`"conn=%{database.password}"`) — only that portion redacts, not the
  whole string (`'conn=[~~REDACTED~~]'`); several secrets interpolated
  into one string each redact independently at their own position.
- **Travels with the value, not just its declared path** — a `%{...}`
  reference or a `for ... from` template that copies a secret value
  elsewhere in the tree copies the wrapping too; a tag (`!int(...)`) or
  index (`[i]`) applied to a secret-sourced value re-wraps its result.

```js
import { loadStringSync, Secret } from 'cooper';

const config = loadStringSync(`#@version = 1.0
db { host = "db.internal", *port = 5432 }
url = "postgres://%{db.host}:%{db.port}"
`);
//=> {
//     db: { host: 'db.internal', port: [~~REDACTED~~] },
//     url: 'postgres://db.internal:[~~REDACTED~~]'
//   }
Secret.reveal(config.db.port);
//=> 5432
config.url.reveal();
//=> 'postgres://db.internal:5432'
```

## Errors

Every failure is a `CooperError` (extends `Error`) — thrown by the
`*Sync` functions, the rejection reason of the async ones. `err.message`
is a human-readable string; `err.stage` says roughly where it came
from; a syntax error also carries `err.line`/`err.column` (1-based) and
`err.offset`; `err.file` is set when the failing source came from a
file; a failure in your own resolver/tag/loader keeps your error as
`err.cause`.

| Stage | Raised for |
|---|---|
| `lexer` / `parser` | CASC syntax the grammar itself rejects. |
| `action` | A literal that parses but fails semantic validation (e.g. a malformed duration/bytes/IP literal, an out-of-range CIDR prefix, an impossible date, an unexpected version-header token). |
| `loop` | A `for` loop's bindings are invalid (index-only loop, mismatched element-list lengths, a non-list iterable). |
| `import` | A file couldn't be read, an import cycle, an unregistered `scheme://`, or a `Promise` from a loader under the `*Sync` API. |
| `merge` | A `~`/`+`/`-` sigil applied to a value it can't operate on (e.g. `+`/`-` against a tuple). |
| `resolve` | An undefined `@{}`/`${}` reference with no default, a `${NAME:?"msg"}` failure, a `%{...}`/`@{...}` reference cycle, an unregistered resolver/tag, a resolver/tag that threw, or a `Promise` from one under the `*Sync` API. |
| `dotenv` | An `.env` file that exists but fails to parse. |

```js
import { loadStringSync, CooperError } from 'cooper';

try {
  loadStringSync('#@version = 1.0\nport = ${PORT}', { dotenv: false });
} catch (err) {
  [err instanceof CooperError, err.stage, err.message];
  //=> [ true, 'resolve', 'undefined reference ${PORT}' ]
}
```

## Test-time injection

`resolvers`/`importSchemes`/`tags` fully replace whatever they'd
otherwise reach for — a plain function or object you supply, no global
state involved:

```js
import { loadString } from 'cooper';

const source = `#@version = 1.0
import "mem://shared"
api_key = !{vault:api/key}
`;

await loadString(source, {
  resolvers: { vault: (payload) => `stub:${payload}` },
  importSchemes: { mem: (rest) => `#@version = 1.0\nshared_from = "${rest}"` },
});
//=> { shared_from: 'shared', api_key: 'stub:api/key' }
```

`env` is different — it's an **override**, not an isolation mechanism
(see [.env files](#env-files)). `env: { DB_PASSWORD: 'test-secret' }`
guarantees `DB_PASSWORD` specifically, but any other `${...}` a test's
source reads still falls through to `.env` files and `process.env`.
Give every name the test depends on an explicit `env` entry rather
than relying on it being otherwise unset; `dotenv: false` additionally
skips the `.env` file layers if a test needs to rule those out too.

## Other exports

| Export | |
|---|---|
| `version` | The installed package version, e.g. `'0.1.0'`. |
| `CooperError` | The one error class (see [Errors](#errors)). |
| `Cache` | See [Caching](#caching). |
| `Dotenv` | See [.env files](#env-files). |
| `Secret`, `Tuple`, `Duration`, `ByteSize`, `LocalDate`, `LocalTime`, `LocalDateTime`, `IPv4`, `IPv6`, `ModuleRef` | The value classes (see [Values](#values)). |
