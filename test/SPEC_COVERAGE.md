# Spec coverage

This table maps every section of [`CASC.md`](../guides/casc/CASC.md) to
the tests covering it. It aims to be honest rather than complete-looking:
the one genuine gap is called out at the bottom.

Every section is additionally covered by the differential conformance
suite (`conformance/oracle.spec.js`). Each `conformance/cases/*.casc` is
checked against the Elixir reference implementation; no case has a
Node-specific override. The `!module` cases run with the one Node-only
option, a `modules` mapping (`conformance/options.js`,
`conformance/DIVERGENCES.md`).

Legend: ✅ covered · ⚠️ partially covered or known gap · N/A out of scope
per the spec itself.

| § | Topic | Status | Tests |
|---|---|---|---|
| 1 | Overview | ✅ | Exercised throughout. It's a summary section, so it has no standalone test. |
| 2 | Mandatory header | ✅ | `grammar/parser.spec.js` (version header); `grammar/values.spec.js` (version header); conformance `001`, `002`, `060`, `916` |
| 3.1 | Whitespace | ✅ | `grammar/lexer.spec.js` (trivia); `grammar/parser.spec.js` (values on the next line); conformance `091` |
| 3.2 | Comments | ✅ | `grammar/lexer.spec.js` (trivia and comments); `grammar/values.spec.js` (comments, `#TODO` vs `# TODO`); conformance `003`, `916` |
| 4.1 | Key names, atoms, variable names | ✅ | `grammar/lexer.spec.js` (maximal munch); conformance `013`, `069` (contextual keywords) |
| 4.2 | Quoted key segments | ✅ | `grammar/parser.spec.js` (key paths and blocks); conformance `006`, `085` (interpolated keys); `pipeline/resolver.spec.js` (a built segment is non-empty and dotless); conformance `122`, `146`–`148`, `150` |
| 4.3 | Secret keys | ✅ | `values/secret.spec.js`; `pipeline/secrets.spec.js` (marking, secrecy travels with copies, partial redaction, never in error messages); `pipeline/merge.spec.js` (secret propagation); conformance `007`, `054`, `055`, `923` |
| 5.1 | Imports | ✅ | `pipeline/loader.spec.js` (bare paths, brace and glob, cycles, schemes, failures); `pipeline/import-interpolation.spec.js` (`${NAME}` in paths); conformance `044`–`050` |
| 5.2 | Variable declarations and visibility | ✅ | `pipeline/loader.spec.js` (visibility: public up and down, private file-local, transitive); conformance `051`, `904`, `917` |
| 5.3 | Assignments (`=` optional) | ✅ | `grammar/parser.spec.js` (assignments); conformance `004`, `005`, `081` |
| 5.4 | Key paths and blocks | ✅ | `grammar/values.spec.js` (key paths and blocks); `pipeline/merge.spec.js` (dotted paths equal nested blocks, a property); conformance `004`, `063`, `070`; an empty block is an empty map: `pipeline/merge.spec.js`, conformance `112`, `113`, `185` |
| 5.5 | Loops | ✅ | `pipeline/loop.spec.js` (zipped iteration, `from`, iterable validation, binding scope, sigils in the body); `pipeline/resolver.spec.js` (`from` end to end); conformance `039`–`043`, `078`–`080`, `911`, `088`, `922`, `101` (a binding in a filter argument), `146`–`148` (keys built from a binding) |
| 5.6 | Disabled statements | ✅ | `grammar/values.spec.js` (disabled statements); `pipeline/resolver.spec.js` (a disabled import does nothing); conformance `008`, `083` |
| 5.7 | Merge control sigils and ordering | ✅ | `grammar/parser.spec.js` (merge control sigils, `followed_delete`); conformance `090`, `092`; `grammar/values.spec.js` (sigil ordering); conformance `009`, `010`, `082` |
| 6.1 | Nil | ✅ | `grammar/values.spec.js`; conformance `011` |
| 6.2 | Booleans | ✅ | `grammar/values.spec.js`; conformance `011` |
| 6.3 | Numbers | ✅ | `grammar/literals.spec.js` (integer properties: every base, separators, beyond the safe range; the internal float and its formatting, a round-trip property); `grammar/values.spec.js` (floats load as plain numbers); `values/cooper-float.spec.js` (the public `CooperFloat`); conformance `012`, `062`, `103`, `104`, `175`–`178` |
| 6.4 | Atoms | ✅ | `grammar/values.spec.js` (bare, `:`-sigiled; `:nil`/`:true`/`:false` are the values, `:inf` an atom); conformance `013`, `901`, `919` |
| 6.5 | Strings | ⚠️ | `grammar/values.spec.js` (double-, single- and triple-quoted, escapes, a round-trip property); conformance `015`, `075`. **Gap:** backslash-continued strings; see below. |
| 6.6 | Dates and times | ✅ | `values/temporal.spec.js` (`DateTime`: UTC, microseconds, precision, `-00:00` refused, exact equality); `grammar/literals.spec.js`; `pipeline/resolver.spec.js` (interpolation); conformance `016`, `087`, `118`, `170`–`174` |
| 6.7 | IP addresses | ✅ | `values/ipv4.spec.js`, `values/ipv6.spec.js` (validation, display, CIDR math, properties); conformance `017` |
| 6.8 | Durations | ✅ | `values/duration.spec.js`; `grammar/literals.spec.js` (compound-literal property, rule violations, exact fractional scaling at any size with half-up rounding, a property); conformance `018`, `913`, `154`, `156`, `157`, `162` |
| 6.9 | Byte sizes | ✅ | `values/byte-size.spec.js`; `grammar/literals.spec.js` (every unit, any case, exact fractional scaling at any size); conformance `019`, `155`–`157`, `162` |
| 6.10 | Lists | ✅ | `grammar/values.spec.js`; conformance `020`; maps inside lists and tuples: `pipeline/merge.spec.js`, conformance `180`–`184` |
| 6.11 | Tuples | ✅ | `values/tuple.spec.js`; `cooper.spec.js` (real `Tuple`s end to end); conformance `021`, `053` |
| 7.1 | Variables (`@{}`) | ✅ | `grammar/interp.spec.js`; `pipeline/resolver.spec.js` (default, substitute, required, indexed, values that are references, cycles); conformance `022`, `059`, `066`; how a value reads in a string (`nil`, floats, `inf`): `pipeline/resolver.spec.js`, conformance `102`, `103`, `150`, `912` |
| 7.2 | Environment expansion (`${}`) | ✅ | `pipeline/resolver.spec.js` (the spec's worked example, list splitting, `${?NAME}` guards); `pipeline/filters.spec.js` (every filter, chaining, both quote styles, errors); `pipeline/built-names.spec.js`; `dotenv.spec.js` (incl. `${COOPER_ENV}`, its `NODE_ENV`/`dev` fallback, and the fallback's name table); `cache.spec.js` (the fallback under `watchEnv`); `pipeline/resolver.spec.js` (a `:?"..."` message interpolates); `pipeline/filters.spec.js` (an interpolated filter argument); conformance `023`–`029`, `168`, `910` |
| 7.3 | Config references (`%{}`) | ✅ | `pipeline/resolver.spec.js` (the worked example, final-tree resolution, cycle detection); conformance `030`, `031` |
| 7.4 | Extensible resolution (`!{}`) | ✅ | `pipeline/resolver.spec.js`; `async.spec.js` (async resolvers, each occurrence resolved once); conformance `032`–`034`, `076` |
| 7.5 | Tagged values (`!Name()`) | ✅ | `pipeline/resolver.spec.js`; `pipeline/filters.spec.js` (normalizing tags); `pipeline/module-tag.spec.js`, `values/module-ref.spec.js` (`!module`: PascalCase names, every rejection including mapped non-PascalCase names, exact-case `modules` lookup, specifier and object values, `process.cwd()`-relative specifiers, the unmapped-name error, lazy `load()`); `pipeline/resolver.spec.js` (`!float` always a float, `!int` refuses one, a consumer's tag receives a float as a `CooperFloat`, nested ones too, and may return one); conformance `035`–`038`, `074`, `105`, `126`, `163`–`167`, `914`, `920`, `175`–`178` |
| 8.1 | Blocks and maps (deep merge) | ✅ | `pipeline/merge.spec.js` (including a random-assignment property); conformance `063` |
| 8.2 | Lists (replace wholesale) | ✅ | `pipeline/merge.spec.js`; conformance `064` |
| 8.3 | Tuples (never merge) | ✅ | `pipeline/merge.spec.js` (`~`, `+` and `-` against a tuple all fail); conformance `052`, `053` |
| 8.4 | Overriding the default (sigils) | ✅ | `pipeline/merge.spec.js` (the worked example; `+` then `-` round-trip property); `pipeline/merge.spec.js` (strict removal: `1` is not `1.0`; `nil` operands); conformance `009`, `065`, `067`, `068`, `907`, `100`, `104`, `149`, `172` (a time or datetime removes only one written to the same precision) |
| 8.5 | Deferred: merge-by-key | N/A | Out of scope for this version, per the spec. |
| 9.1 | Tagged values (extensibility) | ✅ | `pipeline/resolver.spec.js`; `async.spec.js` |
| 9.2 | Extensible resolvers | ✅ | `pipeline/resolver.spec.js`; `async.spec.js`; `cooper.spec.js` |
| 9.3 | Extensible import sources | ✅ | `pipeline/loader.spec.js` (scheme imports, scheme cycles); `cache.spec.js` (coalesced async loaders) |
| 9.4 | Failure semantics | ✅ | Every unregistered tag, resolver and scheme test above fails naming the offender; `async.spec.js` (thrown errors become `CooperError`s) |
| 10 | Minimal valid file | ✅ | conformance `001` |

Beyond the spec: `.env` layering and parsing (`dotenv.spec.js`), the
`loadFile` cache and its diagnostics channels (`cache.spec.js`), sync and
async driver parity (`async.spec.js`, and every conformance case runs
under both), and CJS/ESM entry-point parity (`values/module-parity.spec.js`,
`cooper.spec.js`, `version.spec.js`).

## Known gap

**Backslash-continued strings** (§6.5's fifth string form: "a bare value
starting with `\` at end-of-line joins onto the next line, dropping the
line break") are not implemented, here or in the reference. CASC.md gives
no worked `Result` for this form, so there is nothing concrete to
validate an implementation against without guessing. Both
implementations will add it together, once the spec pins it down.
