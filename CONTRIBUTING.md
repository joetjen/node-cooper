# Contributing to node-cooper

Thanks for considering a contribution. This document covers what you
need to know before opening an issue or a pull request.

## Getting started

```sh
git clone <this repository>
cd node-cooper
npm install
npm test
```

That should complete with no failures on a clean checkout. If it
doesn't, please open an issue before doing anything else; that's a bug
in its own right.

## Project layout

- `src/cooper.{cjs,js}`: the public API (`loadFile`/`loadString` and
  their `*Sync` variants) and the top-level exports.
- `src/values/`: the loaded-value model (`Secret`, `Tuple`, `Duration`,
  `ByteSize`, `LocalDate`/`LocalTime`/`LocalDateTime`, `IPv4`/`IPv6`
  with their CIDR math, `ModuleRef`), plus structural equality.
- `src/grammar/`: a hand-written `lexer.cjs` and PEG `parser.cjs`
  porting the reference's `casc.aether` grammar rule for rule, and
  `interp.cjs` for references inside double-quoted strings (the
  reference's `casc_interp.aether`). `literals.cjs` parses numbers,
  durations, byte sizes and dates.
- `src/pipeline/`: everything after parsing. `evaluate.cjs` walks
  statements into flat entries, `loop.cjs` expands `for` loops,
  `loader.cjs` handles imports, `glob.cjs` does import globbing,
  `merge.cjs` folds entries into a tree, and `resolver.cjs` resolves
  references. `tags.cjs` holds the built-in tags, `filters.cjs` the
  reference filters, and `display.cjs` interpolation rendering.
  `effects.cjs` runs one generator-based pipeline either synchronously
  or asynchronously. `index.cjs` ties the stages together.
- `src/dotenv.cjs`: `.env` layering and the built-in parser.
- `src/cache.cjs`: the `loadFile` cache and its
  `diagnostics_channel` events.
- `test/`: one directory per concern (`values/`, `grammar/`,
  `pipeline/`), plus:
  - `test/conformance/`: differential testing against the Elixir
    reference (see below), with `DIVERGENCES.md`.
  - `test/SPEC_COVERAGE.md`: maps every CASC.md section to its tests.
  - `test/fixtures/`: on-disk import and `.env` fixtures.
- `guides/`: this project's `TUTORIAL.md`/`EXAMPLES.md`/`CHEATSHEET.md`,
  plus `guides/casc/`, the implementation-independent CASC spec, vendored
  unchanged from the Elixir project.
- `scripts/oracle.exs`: the conformance oracle, run inside a `cooper`
  checkout.

Every public module under `src/` ships as a `.cjs` file, the real
implementation and `require()`-able directly, with a thin `.js` ESM
re-export alongside it. Any export change touches both.

## Making a change

1. **Tests first, or at least alongside.** A grammar or resolver change
   should come with a test exercising real input/output behavior, not
   just "does this parse." Update `test/SPEC_COVERAGE.md` alongside any
   change to what's covered.
2. **Check it against the reference.** Add a `.casc` case to
   `test/conformance/cases/`. With Elixir installed and a `cooper`
   checkout at `../cooper`, run `npm run oracle` to generate its
   `.expected.json` from the Elixir implementation, then `npm test`. The
   reference is the authority: if the two disagree, fix this port, or,
   if the reference is wrong, fix it there first. Only a difference
   inherent to the host language would get this port's result in
   `<case>.node.json` and a row in `test/conformance/DIVERGENCES.md`;
   today there are none. A case that loads a `!module("Name")` needs
   that name in the `modules` mapping in `test/conformance/options.js`.
   Never hand-edit an `.expected.json`.
3. **Both drivers.** Anything that calls user code (resolvers, tags,
   import-scheme loaders) has to work under `loadString` (async) and
   `loadStringSync`. Test both.
4. **Property tests where the input space is large.** Parsers, literals,
   and merge logic get `fast-check` properties, not just more examples.
5. **Run the full verification pass before opening a PR:**

   ```sh
   npm run precommit
   npm run docs
   ```

   `npm run precommit` type-checks the JSDoc (`tsc --checkJs --noEmit`)
   and runs the whole Mocha suite. `npm run docs` builds the TypeDoc API
   reference into `doc/`.

## Commits and branches

This project uses [git flow](https://nvie.com/posts/a-successful-git-branching-model/)
(`feature/*` branches off `develop`) and
[Conventional Commits](https://www.conventionalcommits.org/)
(`feat(grammar): ...`, `fix(resolver): ...`). Add a line under
`[Unreleased]` in `CHANGELOG.md` for any user-facing change.

## Reporting bugs

Please include the smallest CASC source that reproduces the problem, the
options you passed, what you expected, and what happened, with the
`CooperError`'s `stage` and message. If the Elixir `cooper` behaves
differently on the same input, say which way. That tells us which
implementation needs the fix.
