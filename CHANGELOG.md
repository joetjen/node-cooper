# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-08

### Fixed

- **The package ships TypeScript declarations.** 0.1.0 had none: its
  types lived only in JSDoc, which TypeScript does not read from a
  package in `node_modules`, so every value from `@joetjen/cooper` was
  an implicit `any` to a TypeScript application -- and a `checkJs`
  project, `@joetjen/cooper-config` among them, did not type-check.
  The declarations are generated from that JSDoc when the package is
  packed, for the ES-module and CommonJS entries alike, and
  `test/types` compiles an application of each kind against them.

## [0.1.0] - 2026-10-08

Published as **`@joetjen/cooper`**, under the author's npm scope: the
unscoped `cooper` is another project's. The scope matches the PHP
packages' `joetjen/` vendor name.

### Added

- Project scaffold mirroring `node-dextrin`: `package.json` (zero runtime
  dependencies, Node.js 20+), the dual CJS/ESM entry-point convention,
  Mocha/Chai/fast-check tests, `tsc --checkJs` type-checking, TypeDoc
  API docs, and GitHub Actions for CI, docs and a monthly dependency
  audit.
- Licensed under the Apache License 2.0.
- A port of `cooper`'s whole loading pipeline, matching the Elixir
  reference's 0.5.0 case for case on the shared conformance corpus:
  - a hand-written CASC lexer and PEG parser, porting the reference
    grammar rule for rule;
  - `for` loops, imports (bare paths with brace and glob expansion,
    `${NAME}` in paths, `scheme://` loaders), and merge with
    `~`/`+`/`-` sigils;
  - secrets, and `@{}`/`${}`/`%{}`/`!{}`/`!Name()` resolution with
    filters and built names;
  - the built-in tags `!int`, `!float`, `!bool`, `!duration`, `!bytes`,
    `!trim`, `!downcase`, `!upcase` and `!module`.
- `loadFile`/`loadString` (Promise-returning, with async resolvers,
  tags and import-scheme loaders) and `loadFileSync`/`loadStringSync`,
  all driven by one generator-based pipeline.
- The value model: `Secret` (redacted in `String()`, `JSON.stringify`
  and `util.inspect`, with a non-enumerable `value`), `Tuple`,
  `Duration`, `ByteSize`, `LocalDate`, `LocalTime`, `LocalDateTime`,
  `IPv4`/`IPv6` with CIDR helpers, and `ModuleRef`. Integers are a
  `number` when safe and a `bigint` beyond; atoms are `Symbol.for(name)`.
- `CooperError`, with the reference's stage names and line/column for
  syntax errors.
- `.env` layering (`.env`, `.env.<COOPER_ENV>`, `.env.local`,
  `process.env`, the `env` option) with a built-in, dependency-free
  parser that never executes `$(command)`.
- The `loadFile` cache, keyed by file modification times, with
  environment polling and `node:diagnostics_channel` events
  (`cooper:cache:file_changed`, `cooper:cache:env_changed`).
- Differential conformance testing against the Elixir reference
  (`test/conformance/`, `scripts/oracle.exs`).
- `guides/casc/`, the CASC spec, vendored from `@joetjen/cooper`.
- **A list or tuple element may be a block -- a map** (CASC.md §6.10):
  `access_control = [{ path = "^/admin" }]`. Its keys interpolate, a
  loop binding reaches it, and `+`/`-` append or remove whole maps,
  compared by value. A list of maps could not be written before.
- `${COOPER_ENV}` is always defined (CASC.md §7.2): a real `COOPER_ENV`
  from any layer wins; unset or empty, it falls back to `NODE_ENV` from
  the same layers, else `"dev"`. A real `COOPER_ENV` is passed through
  unchanged; the `NODE_ENV` fallback is mapped onto the names every
  Cooper uses (`dev`, `staging`, `test`, `prod`) through CASC.md §7.2's
  one table: `development` and `local` become `dev`, `testing` becomes
  `test`, `production` becomes `prod`, and anything else is passed
  through. `Dotenv.env`
  and the cache's `watchEnv` poll see the same value a load resolves
  against.
- The `.env.<env>` file is named by `COOPER_ENV`, as the real
  environment, the `env` option and the base `.env` set it: `.env.dev`,
  `.env.staging`, `.env.test` and `.env.prod`, the names every Cooper
  reads, so `NODE_ENV=production` reads `.env.prod`. An explicit
  `dotenvEnv` still wins.

### Changed

- **`!bool` reads `1`/`0`, `yes`/`no` and `on`/`off`** besides
  `true`/`false` (lower case only; anything else is still refused), so
  `DEBUG=1`, the commonest `.env` spelling of a boolean, no longer fails
  the load (CASC.md §7.5; conformance cases `186` and `187`).
- **An empty block is an empty map** (CASC.md §5.4): `w {}` and `w = {}`
  were no key at all, and `~w {}` removed the key. Written over a map
  that already exists it leaves that map as it is; `~w {}` empties it.
- **`!module("Name")` takes a dot-separated PascalCase name, mapped by
  the new `modules` load option** (CASC.md §7.5) -- **breaking**. The
  name is written the same way for every Cooper implementation; a Node
  module specifier (`./x.js`, `node:fs`, `@scope/pkg`, `lodash`) is no
  longer accepted inside CASC, nor is `crypto`, `Foo.bar` or `Foo_Bar`,
  even when `modules` holds it. Every load function (`loadFile`,
  `loadFileSync`, `loadString`, `loadStringSync`, cached or not) takes
  `modules`, an object or `Map` from the name exactly as written to a
  specifier string (a relative one resolved against `process.cwd()`, no
  longer against the config file's directory) or to the module itself.
  A name it does not hold is a `resolve`-stage error naming the option:
  a Node module is a location, so there is no convention to fall back
  on. Nothing is imported at load time. `ModuleRef` now keeps `name` (as
  written), and `specifier` or `value`; `resolved` is gone, `specifier`
  is what `load()` imports, and `load()` hands a mapped non-string value
  back as is. A `ModuleRef` renders as its name.
- The Elixir reference is now the authority for conformance: every case
  loads exactly as it does there, with no `<case>.node.json` override
  left. The `!module` cases run with a `modules` mapping, the one
  Node-only option, and `DIVERGENCES.md` lists only host differences.
- `:nil`, `:true` and `:false` load as `null`, `true` and `false`, not as
  atoms (CASC.md §6.4). `:inf` is still the atom `inf`.
- A value interpolated into a string reads as CASC writes it (CASC.md §7):
  `nil` as `nil` (was empty), and a float as its shortest round-trip
  digits, always with a fraction, as a decimal or with an exponent,
  whichever is shorter (`1.0`, `100.0`, `1.0e3`, `1.0e-5`, `1.0e20`).
- A float stays a float through a load, although it still reaches the
  caller as a plain `number`. So `-key = [1.0]` removes only `1.0`, never
  `1` (CASC.md §8.4); `!float(...)` always yields a float; and `!int(2.0)`
  is an error.
- A tag registered with `tags:` receives a float as a `CooperFloat`, now
  public and exported, nested ones included (in a list, tuple, map, or
  secret), so it can tell `!twice(2.0)` from `!twice(2)` as the
  reference's tags can; it received plain numbers. A tag may return a
  `CooperFloat`, which stays a float for the rest of the load. The loaded
  config still holds plain numbers.
- An offset datetime (`1979-05-27T07:32:00.120+05:30`) loads as the new
  `DateTime`, exported from both entry points, instead of a native
  `Date`: UTC, at microsecond resolution, keeping the fraction digits
  written (`.120` stays `.120`, `.0` stays `.0`; digits past the sixth are
  truncated), and interpolating as the reference writes it
  (`1979-05-27 02:02:00.120Z`). `toDate()`/`DateTime.fromDate()` convert.
  It loaded as a `Date`, which dropped every digit past the millisecond.
- An interpolated key segment must resolve to a non-empty string with no
  `.` in it, inside a `for` loop as outside one (CASC.md §4.2). A float
  counts: `"k-@{f}"` with `1.5` is `"k-1.5"`, which is refused.
- The message of `:?"..."` interpolates (`@{n:?"need @{m}"}` fails with
  `need M`), and a secret in it shows redacted.
- A double-quoted filter argument interpolates like any double-quoted
  string, so a loop binding reaches one:
  `| trim_suffix: "@{x}"`.

### Fixed

- `.env` files were read from the working directory, so a process
  started from anywhere but its own root read none of them. They are
  now read from `dotenvDir` -- a new option, also the base of a
  relative `dotenvFiles` entry -- which defaults to the project root:
  the nearest `package.json` above the working directory, else the
  working directory (`Dotenv.projectRoot()`). The `watchEnv` poll keeps
  the directory the load used, as the reference now does.

- The cache missed a file added where a glob import looks: it
  fingerprinted only the files a load read, so an edited or deleted one
  was noticed and a new match for `import "parts/*.casc"` was not. Each
  import's expansion is now part of the fingerprint and is expanded
  again on every cache hit; the file it gained or lost is named in
  `cooper:cache:file_changed`, as the reference now does.

- A fractional single-unit duration or byte size (`1.5h`, `1.0005KB`,
  `!duration("0.5ns")`) is computed exactly, with integers at any size:
  the amount's digits times the unit, divided by 10 to the number of
  fraction digits, rounded half away from zero, as the reference now
  does. It went through a float, so `1.0005KB` was `1000` bytes rather
  than `1001`, and digits past 2^53 were lost.

- `-key = [...]` removes a time, local datetime, or offset datetime only
  where it was written to the same precision, as in the reference:
  `07:32:00.0` no longer removes `07:32:00`. `LocalTime#equals` and
  `LocalDateTime#equals` compare the precision too.
- The offset `-00:00` (RFC 3339's "offset unknown") is a load-time error,
  as in the reference; it loaded as UTC.

These were bugs in the Elixir reference when this port was written; the
reference fixed them in its 0.5.0:

- `foo "bar"` works without `=`.
- `-key` inside a block deletes the key.
- Disabled statements have no effect at all.
- Private variables can reference private variables.
- `+infra` is a key, not `+inf` followed by `ra`.
- Interpolated keys are resolved.
- `+tags = @{more}` appends element-wise.
- `${X:+1}` is the substitute form.
- Loop variables keep their filters, index and suffix.
- A loop body's `~key { }` clears under the destination.
- A comment may precede the version header.
- A bare `-key.path` followed by another complete statement is a delete,
  per CASC.md §5.7's `followed_delete` rule, rather than swallowing the
  next statement's key as a remove value.
- `1_000ms` is a valid duration.
- Invalid dates and list interpolation are clean errors.
- Scheme-import cycles are detected.
- `+key`/`-key` in a `for ... from` body apply to the template's copy.
- Filters work on secret-sourced references, keeping the result secret.
- The cache's environment watch keeps its original baseline, so a change
  landing between two loads still invalidates a stale `${?NAME}` guard.
