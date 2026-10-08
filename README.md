# node-cooper

Cooper loads [CASC](guides/casc/CASC.md) config files into native
JavaScript values. CASC is a hierarchical, extensible config language
with imports, variables, string interpolation, environment and config
references, loops, and resolvers and tags your application registers.

This is the Node.js port of [`cooper`](https://github.com/joetjen/cooper)
(Elixir). Both read the same files and produce the same structure.

```text
#@version = 1.0

@region = "eu-west"

server {
  host = "0.0.0.0"
  port = 8080
}

database {
  *password = ${DB_PASSWORD}
  host = "db.@{region}.internal"
  pool_size = 10
  timeout = 500ms
}
```

```js
import { loadFile } from 'cooper';

const config = await loadFile('config.casc', { env: { DB_PASSWORD: 'hunter2' } });
console.log(config);
// {
//   server: { host: '0.0.0.0', port: 8080 },
//   database: {
//     password: [~~REDACTED~~],
//     host: 'db.eu-west.internal',
//     pool_size: 10,
//     timeout: Duration(500000000ns)
//   }
// }

config.database.password.reveal();       // 'hunter2'
config.database.timeout.toMilliseconds(); // 500
```

Blocks come back as plain objects with string keys. Durations and byte
sizes come back as `Duration`/`ByteSize`. Tuples come back as real
`Tuple`s, never coerced to arrays (CASC.md §6.11). Any `*key`-prefixed
value is wrapped in a `Secret`, which `String()`, template literals,
`JSON.stringify` and `console.log` all redact. Call `reveal()` to get the
real value.

`require('cooper')` works the same as `import`.

## Values

| CASC | JavaScript |
| --- | --- |
| block `{ ... }` | plain object, string keys |
| list `[...]` | array |
| tuple `(...)` | `Tuple` (frozen, fixed arity, `toArray()`) |
| `nil`, `true`, `false` (also `:nil`, `:true`, `:false`) | `null`, `true`, `false` |
| integer | `number`, or `bigint` beyond `Number.MAX_SAFE_INTEGER` |
| float, `inf`, `-inf` | `number`, `Infinity`, `-Infinity` (a float stays a float inside a load: `"@{f}"` reads `1.0`, and `-key = [1.0]` leaves `1` alone; a tag you register receives it as a `CooperFloat`, so it can tell `2.0` from `2`) |
| atom `info`, `:info`, `:inf` | `Symbol.for('info')` (not emitted by `JSON.stringify`) |
| string | `string` |
| duration `500ms`, `1h30m` | `Duration` (`nanoseconds: bigint`, `toMilliseconds()`) |
| byte size `512MiB` | `ByteSize` (`bytes: bigint`, `toNumber()`) |
| `1979-05-27T07:32:00Z`, `...07:32:00.120+05:30` | `DateTime` (UTC, microseconds, the fraction digits as written; `toDate()`) |
| `1979-05-27T07:32:00` / `1979-05-27` / `07:32:00` | `LocalDateTime` / `LocalDate` / `LocalTime` |
| `10.0.0.0/8`, `::1` | `IPv4` / `IPv6` (with CIDR helpers) |
| `*key = ...` | `Secret` |
| `!module("Acme.Payments")` | `ModuleRef` for what the `modules` option maps that name to (`load()` imports it) |

## Sync or async

`loadFile` and `loadString` return a Promise. Use them whenever a
resolver, tag, or import-scheme loader you register is asynchronous;
a secrets manager, for one, is a network call:

```js
const config = await loadFile('config.casc', {
  resolvers: { vault: (path) => vault.read(path) }, // !{vault:secret/db/password}
});
```

`loadFileSync` and `loadStringSync` return the value directly, which
suits plain files read at startup. A registered callback that returns a
Promise there is an error naming it, never a silently unresolved value.

Every failure is a `CooperError`, thrown or rejected, whose `stage`
names where it happened: `lexer`, `parser`, `action`, `loop`, `import`,
`merge`, `resolve` or `dotenv`. Syntax errors also carry `line` and
`column`.

## How it fits together

Loading a file runs one pipeline:

1. **Lex and parse.** A hand-written lexer and PEG parser
   (`src/grammar/`) port the reference implementation's grammar rule for
   rule.
2. **Evaluate.** Statements run in order (`src/pipeline/evaluate.cjs`).
   Literals become values, `for` loops expand (`loop.cjs`), and imports
   are loaded and spliced in place (`loader.cjs`), so an import's
   variables are visible to what follows it.
3. **Resolve keys.** Interpolated keys such as `"@{name}" = 1` are
   resolved before merging.
4. **Merge.** The flat list of assignments folds into a tree
   (`merge.cjs`), honoring the `~`/`+`/`-` sigils. Every `*key` is
   wrapped in a `Secret` here, so the redaction travels with the value
   through any later reference.
5. **Resolve references.** `@{}` variables, `${}` environment reads,
   `%{}` config references (lazily, against the final tree, with cycle
   detection), `!{resolver:...}` and `!Name(...)` tags are all resolved
   (`resolver.cjs`).

See the [tutorial](guides/TUTORIAL.md) for a walkthrough of the library
and the CASC syntax, or the [cheatsheet](guides/CHEATSHEET.md) for a
terse API reference.

## .env files

`${...}` reads pick up `.env`, `.env.<COOPER_ENV>` and `.env.local` from the
project root automatically -- the directory of the nearest `package.json`
above the working directory, else the working directory itself, so a
process started from a subdirectory still finds them. `dotenvDir` names
another directory. No option is needed and there is no
dependency: the parser is built in and reads the same format as the
Elixir side's `dotenvy`. One exception: a `$(command)` is never executed.

**The real environment outranks those files.** The `env` option outranks
everything, but only for the names it defines. A deployment sets
variables in the environment it controls, and a file in the working
directory must not silently beat them. That is also Node's `dotenv`
default. Pass `dotenvOverride: true` to put the files on top instead,
which can help locally to shadow something exported in your shell.

## `${COOPER_ENV}`

Every Cooper implementation reads the current environment by one name,
so a document selects per-environment files the same way everywhere:

```casc
import "env/${COOPER_ENV}.casc"
```

A real `COOPER_ENV` (in the environment, a `.env` file or the `env`
option) always wins, exactly as set. Unset or empty, it falls back to
`NODE_ENV` from those same layers, else `"dev"`. Every Cooper names its
environments `dev`, `staging`, `test` and `prod`, and in that fallback
maps the host's spellings onto them through one table (CASC.md §7.2):

| `NODE_ENV` | `COOPER_ENV` |
|---|---|
| `development`, `local` | `dev` |
| `testing` | `test` |
| `production` | `prod` |
| anything else (`dev`, `staging`, `test`, `prod`, `qa`, ...) | unchanged |

So `NODE_ENV=development` reads `env/dev.casc`. Matches are exact and
case-sensitive.

The same `COOPER_ENV` names the `.env.<env>` file, as the real
environment, the `env` option and the base `.env` set it: `.env.dev`,
`.env.staging`, `.env.test` and `.env.prod`, in every Cooper. So
`NODE_ENV=production` reads `.env.prod`, never `.env.production`. An
explicit `dotenvEnv` still names the file outright.

## Caching

`loadFile` caches everything up to the final reference-resolution step
by default. The cache is keyed by the modification times of the file and
everything it imports, so a repeat load of unchanged files skips parsing
entirely. `${...}` values are re-resolved on every call, hit or miss.
Pass `cache: false` to opt out for one call.

Cache events go out on two `node:diagnostics_channel` channels:

- `cooper:cache:file_changed` fires when a cached file changes.
- `cooper:cache:env_changed` fires when an environment variable the file
  actually reads changes. Polling for this is on by default for files
  that use `${...}`, through the `watchEnv` option.

## Installation

```sh
npm install cooper
```

Node.js 20 or later. No runtime dependencies.

## Where to go next

- **[Tutorial](guides/TUTORIAL.md):** loading config, secrets, guards,
  error handling, test-time env and import injection, `.env` files,
  caching, and enough CASC syntax to follow along.
- **[Examples](guides/EXAMPLES.md):** layered per-environment config, a
  real secrets manager, IP allowlisting, generating per-shard config from
  a template, and testing config-loading code without touching disk.
- **[Cheatsheet](guides/CHEATSHEET.md):** a quick reference for the API.
- **[CASC tutorial](guides/casc/TUTORIAL.md)** and
  **[CASC reference](guides/casc/CASC.md):** everything about the
  language itself, independent of any implementation. Results there are
  written as Elixir terms. The value table above gives the JS
  equivalents.

## Other language implementations

CASC's spec ([`casc/CASC.md`](guides/casc/CASC.md)) is
implementation-independent. This library is checked case by case against
the Elixir reference implementation (`test/conformance/`), which is the
authority: the two load every case alike. A `!module("Name")` name is
written the same way for both; where Elixir translates it into a module
by convention, Node needs the `modules` option to map it, since a Node
module is a location rather than a name. That and the JS value model's
other host differences are listed in
[`DIVERGENCES.md`](test/conformance/DIVERGENCES.md).

| Language | Package | Source |
| --- | --- | --- |
| Elixir | [`cooper` on Hex.pm](https://hex.pm/packages/cooper) | [joetjen/cooper](https://github.com/joetjen/cooper) |
| Node.js (this project) | [`cooper` on npm](https://www.npmjs.com/package/cooper) | [joetjen/node-cooper](https://github.com/joetjen/node-cooper) |

## Development

```sh
npm install
npm run precommit
```

`npm run precommit` runs `tsc --checkJs --noEmit` to type-check the JSDoc
annotations, followed by the full Mocha test suite. This project expects
it to pass before every commit. `npm run oracle` regenerates the
conformance expectations from a `cooper` checkout in `../cooper`; this
needs Elixir.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes, and
[CHANGELOG.md](CHANGELOG.md) for release history.

## License

Apache-2.0, see [LICENSE](LICENSE).
