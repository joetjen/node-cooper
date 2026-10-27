# Divergences from the Elixir reference

`node-cooper` is held to the same cases as the Elixir implementation,
[`cooper`](https://github.com/joetjen/cooper), by the Cooper Conformance
Suite in the praxis repository
(`libs_prx/cooper_conformance`, run by `assize`). The suite owns the
cases; it reaches this port through its adapter,
`node bin/cooper.js conformance REQUEST ANSWER` (`src/conformance.cjs`).

The reference is the authority. This port behaves exactly like it, except
where a difference is inherent to the host language. Where the reference
and [`CASC.md`](../../guides/casc/CASC.md) disagree, the fix goes to the
reference (and its spec) first, and this port follows once it is there.
It never keeps its own reading of the spec. A behaviour change needs a
case in the suite, not just a unit test here.

## A `modules` mapping for every name

The suite fixes every case's load options, the module mapping included:
every adapter maps `Crypto`, so a mapped module reads in a string as what
it maps to (`crypto`, CASC.md §7). This adapter's mapping (`MODULES` in
`src/conformance.cjs`) holds more.

A `!module("Name")` name is written the same way for every
implementation, dot-separated PascalCase (CASC.md §7.5). The reference
translates a name it is not given a mapping for by convention
(`Acme.Payments` is the Elixir module `Acme.Payments`). A Node module is
a location, not a name, so there is no convention to translate into, and
a name the `modules` option does not hold is a `resolve`-stage error.
The mapping therefore holds every name the suite's cases load
successfully (`Acme.Payments.StripeClient`, `ASCO.HTTPClient`, `Cooper`,
`Foo.Bar`; cases `163` and `920`). Each of those four maps to a module
object, as if the application had imported it, so in a string it reads
as the name written, like the reference's unmapped module; a specifier
would read as itself. A module travels in an answer by its name as
written, tagged `casc/module`. Every name a case expects to fail (`126`,
`164`–`167`, `914`) stays unmapped; it fails on its shape, before the
mapping is asked.

## Floats in an answer

JavaScript has one number type, so a loaded float reaches the caller as
a plain `number`, and `2.0` and `2` cannot be told apart in a loaded
config. Inside a load the difference is kept
(`src/values/cooper-float.cjs`): `"@{f}"` reads `1.0`, `-a = [1.0]` does
not remove `1`, `!float(7)` is a float, and a consumer's tag is handed a
`CooperFloat`, so `!twice(2.0)` fails as in the reference (case `175`).
The adapter takes the resolved tree before its floats are unwrapped, so
it answers `2.0` as `{"float": "2.0"}`, exactly as the reference does.

Everything else answers exactly, offset datetimes included: a
`DateTime` keeps the reference's microseconds and fraction digits.

## Host differences no case exercises

These are not bugs on either side; they are where a JS value model or the
Node platform differs from Elixir's.

| Area | Reference | This port | Why |
| --- | --- | --- | --- |
| Integers | Arbitrary-precision | `number` when `Number.isSafeInteger`, `bigint` beyond | Exact for every integer without making `port = 8080` a `bigint`. |
| Atoms | Elixir atoms | `Symbol.for(name)` | The closest JS analog. Like an atom, it is never garbage-collected. `JSON.stringify` drops symbol values. |
| Dates and times | `Date`/`Time`/`NaiveDateTime`/`DateTime` | `LocalDate`/`LocalTime`/`LocalDateTime`/`DateTime` classes, at the same microsecond resolution and precision | JS has no native zone-less types, and a native `Date` holds only milliseconds (`DateTime#toDate()` gives one). |
| Tuples | Elixir tuples | frozen `Tuple` instances | §6.11 requires a real tuple type. |
| API shape | `{:ok, v} \| {:error, %Ichor.Error{}}` | throws/rejects `CooperError` (same `stage` names) | Idiomatic JS, like `node-dextrin`. |
| Sync/async | One blocking API | `loadFile`/`loadString` (async callbacks allowed) and `*Sync` variants | Resolvers, tags and import loaders are often async in Node. |
| `.env` parsing | `dotenvy` dependency | built-in parser, same format | Zero runtime dependencies. Unlike `dotenvy`, it never executes a `$(command)`, and a `'single-quoted'` value does not switch `${VAR}` interpolation off for the rest of the file. |
| Cache telemetry | `:telemetry` events `[:cooper, :cache, ...]` | `node:diagnostics_channel` channels `cooper:cache:file_changed`/`env_changed` | Node's built-in equivalent, free with no subscriber. |
| Cache scope | Keyed by path and root | Also keyed by path and root. In addition, the environment names read by an import path or a key invalidate the entry like a `${?NAME}` guard does. | Those also shape the cached tree. |
| Import globs | `Path.wildcard` | built-in matcher; a segment starting with `**` (`**.casc`) is recursive | Matches §5.1's own `config/{base,dev}/**.casc` example. |
| Resolver/tag calls | A `!{...}` referenced through `%{...}` may run twice | Each `!{...}`/`!Name(...)` occurrence runs once per load | A resolver is often a network call. |
| Error messages | Ichor's wording | Own wording, with line and column for syntax errors | Only the `stage` is compared. |
| `!module` | A name not in `:modules` is the Elixir module of that name | A name not in `modules` is a load error; a mapped specifier is imported only by `ModuleRef#load()` | A Node module is a location, not a name (CASC.md §7.5). |
