'use strict';

/**
 * @fileoverview This implementation's adapter for the Cooper Conformance
 * Suite: a JSON request in, a JSON answer out (`node bin/cooper.js
 * conformance REQUEST ANSWER`). The Node port of the Elixir reference's
 * `Cooper.Conformance`, answering exactly as it does.
 *
 * The suite (`libs_prx/cooper_conformance` in the Praxis repository, run
 * by its `assize` library) holds every CASC implementation to the same
 * cases. Each case asks for one operation, `load`, on a document file;
 * this answers with the loaded configuration in the suite's typed JSON,
 * or with the category (CASC.md §9.5) of the error that refused it:
 *
 *     {"cases":   [{"id": "c", "operation": "load", "document": "/abs/a.casc"}]}
 *     {"results": [{"id": "c", "result": {"map": [["a", {"integer": "1"}]]}}]}
 *
 * ## What every adapter loads with
 *
 * The suite fixes the environment and the extension points, so a case can
 * use them and every implementation sees the same: the variables in
 * `ENV`, no `.env` file, the document's own directory as the root, the
 * resolvers `echo` (answers its payload) and `fail` (refuses), the tag
 * `twice` (doubles an integer, repeats a string) and the import scheme
 * `mem:` (`mem:base`, `mem:vars`). Node adds one option the reference
 * does without, `modules`: a Node module is a location, not a name, so a
 * `!module("Name")` needs a mapping (`MODULES`). `test/conformance/
 * options.js` runs the shared corpus with these same options.
 *
 * ## Values
 *
 * Every value travels in the suite's typed JSON: `{"integer": "42"}`,
 * `{"float": "2.0"}`, `{"keyword": "info"}`, `{"tuple": [...]}`,
 * `{"map": [[key, value], ...]}`, arrays, and strings, booleans and
 * `null` as they are. What CASC has and Praxis notation has no literal
 * for is a tuple tagged with a dotted keyword -- `casc.duration`,
 * `casc.bytes`, `casc.secret`, `casc.module`, `casc.float`, `casc.ipv4`,
 * `casc.ipv6`, `casc.date`, `casc.time`, `casc.local-date-time`,
 * `casc.date-time` -- which no CASC atom can be, so a tag never reads as
 * a tuple a document wrote.
 *
 * ## Floats
 *
 * A loaded config holds a float as a plain `number`, so `2.0` and `2`
 * cannot be told apart in it (`values/float.cjs`). The suite tells them
 * apart, as CASC does, so this adapter does not use `loadFileSync`: it
 * runs the same pipeline stages itself (uncached, as the reference's
 * adapter loads) and takes the resolved tree before its floats are
 * unwrapped, every float still a `CooperFloat`.
 */

const fs = require('node:fs');
const path = require('node:path');
const CooperError = require('./error.cjs');
const Dotenv = require('./dotenv.cjs');
const { runSync } = require('./pipeline/effects.cjs');
const { loadTree, resolveWrapped } = require('./pipeline/index.cjs');
const { formatFsError } = require('./pipeline/loader.cjs');
const { isPlainObject } = require('./values/equality.cjs');
const { formatFloat } = require('./values/float-format.cjs');
const {
  Secret, Tuple, Duration, ByteSize, LocalDate, LocalTime, LocalDateTime, DateTime, CooperFloat, IPv4, IPv6, ModuleRef,
} = require('./values/index.cjs');

/**
 * A case of a request.
 * @typedef {object} ConformanceCase
 * @property {string} id
 * @property {string} [operation] -- `load` is the one this adapter knows
 * @property {string} [document] -- `load`: the absolute path of the document
 */

/**
 * The answer to one case: its `result` in typed JSON, or its `error`.
 * @typedef {{id: string, result: unknown} | {id: string, error: string}} ConformanceResult
 */

/**
 * The environment every case loads with, identical to the reference
 * adapter's `@env`.
 * @type {Readonly<Record<string, string>>}
 */
const ENV = Object.freeze({
  REGION: 'eu-west',
  PORT: '9090',
  DEBUG: 'true',
  EMPTY: '',
  LIST: 'a, b;c',
  SCHEME: 'HTTPS://',
  PADDED: '  padded  ',
  TOKEN_1: 'tok-one',
  TOKEN_2: 'tok-two',
  FEATURE: 'on',
  WHICH: 'dev',
  FORMATTER: 'Foo.Bar',
  // Set, so a case reading it sees one value in every implementation
  // rather than each host's own fallback (MIX_ENV, NODE_ENV, ...).
  COOPER_ENV: 'conformance',
});

/**
 * The one Node-only option. The reference translates a `!module("Name")`
 * name into an Elixir module by convention and needs no mapping; a Node
 * module is a location, not a name, so this port requires every name in
 * `modules` (CASC.md §7.5). These are the names the cases load
 * successfully; a module travels by its name as written, so what each
 * maps to never reaches an answer. Names a case expects to fail stay
 * out: they must fail on their shape, mapped or not. See
 * `test/conformance/DIVERGENCES.md`.
 * @type {Readonly<Record<string, string>>}
 */
const MODULES = Object.freeze({
  'Acme.Payments.StripeClient': './lib/payments/stripe.js',
  'ASCO.HTTPClient': '@asco/http-client',
  Cooper: '@joetjen/cooper',
  'Foo.Bar': 'node:path',
});

/**
 * What the `mem:` import scheme serves, identical to the reference
 * adapter's `@mem`.
 * @type {Readonly<Record<string, string>>}
 */
const MEM = Object.freeze({
  base: '#@version = 1\nfrom_mem = true\nshared = "mem"\n',
  vars: '#@version = 1\n@mem_var = "from-mem"\n',
});

/**
 * The load options every case runs with, the suite's fixed standard (see
 * the module doc), for a document in `root`.
 * @param {string} root -- the document's own directory
 * @returns {import('./cooper.cjs').LoadOptions}
 */
function loadOptions(root) {
  return {
    env: { ...ENV },
    dotenv: false,
    cache: false,
    root,
    resolvers: {
      echo: (payload) => payload,
      fail: (payload) => {
        throw new Error(`refused ${payload}`);
      },
    },
    tags: {
      // An integer doubles, a string repeats, and anything else is
      // refused -- a float too, which reaches a tag as a `CooperFloat`
      // (so `!twice(2.0)` fails as in the reference). An integer may be
      // a `bigint`, and doubles exactly like an Elixir one.
      twice: (arg) => {
        if (typeof arg === 'bigint' || (typeof arg === 'number' && Number.isInteger(arg))) {
          const doubled = BigInt(arg) * 2n;
          return Number.isSafeInteger(Number(doubled)) ? Number(doubled) : doubled;
        }
        if (typeof arg === 'string') return arg + arg;
        throw new Error(`cannot double ${String(arg)}`);
      },
    },
    modules: { ...MODULES },
    importSchemes: {
      mem: (rest) => {
        if (!Object.hasOwn(MEM, rest)) throw new Error('enoent');
        return MEM[rest];
      },
    },
  };
}

/**
 * Reads the request at `requestPath` and writes the answer to
 * `answerPath`. Throws only when the request cannot be read or decoded,
 * or the answer cannot be written: a case that fails is an answer, not
 * an error.
 * @param {string} requestPath
 * @param {string} answerPath
 * @returns {void}
 */
function run(requestPath, answerPath) {
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  fs.writeFileSync(answerPath, JSON.stringify(answer(request)));
}

/**
 * The answer to a decoded request: one result per case, in order.
 * @param {{cases: ConformanceCase[]}} request
 * @returns {{results: ConformanceResult[]}}
 */
function answer(request) {
  if (!Array.isArray(request?.cases)) throw new TypeError('a request holds a "cases" array');
  return { results: request.cases.map(result) };
}

/**
 * `value`, as this implementation holds a loaded configuration (floats
 * still `CooperFloat`s, or plain fractional `number`s), in the suite's
 * typed JSON.
 * @param {unknown} value
 * @returns {unknown}
 */
function encode(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return { integer: value.toString() };
  if (typeof value === 'number') return encodeNumber(value);
  if (value instanceof CooperFloat) return encodeNumber(value.value, true);
  if (typeof value === 'symbol' && value.description !== undefined) return { keyword: value.description };
  if (Array.isArray(value)) return value.map(encode);
  if (value instanceof Tuple) return { tuple: value.items.map(encode) };
  if (value instanceof Duration) return tagged('casc.duration', encode(value.nanoseconds));
  if (value instanceof ByteSize) return tagged('casc.bytes', encode(value.bytes));
  if (value instanceof Secret) {
    return value.redacted === null ? tagged('casc.secret', encode(value.value)) : tagged('casc.secret', encode(value.value), value.redacted);
  }
  // A module built by `!module(...)` (§7.5) travels by the name CASC
  // wrote, so every implementation compares the name rather than its
  // host's value.
  if (value instanceof ModuleRef) return tagged('casc.module', value.name);
  if (value instanceof IPv4) return tagged('casc.ipv4', value.toString());
  if (value instanceof IPv6) return tagged('casc.ipv6', value.toString());
  // Each `toString()` writes what Elixir's `to_iso8601/1` does for the
  // reference's value, precision included.
  if (value instanceof LocalDate) return tagged('casc.date', value.toString());
  if (value instanceof LocalTime) return tagged('casc.time', value.toString());
  if (value instanceof LocalDateTime) return tagged('casc.local-date-time', value.toString());
  if (value instanceof DateTime) return tagged('casc.date-time', value.toString());
  if (isPlainObject(value)) {
    return {
      map: Object.keys(value)
        .sort(byBytes)
        .map((key) => [key, encode(value[key])]),
    };
  }
  throw new TypeError(`no typed form for ${String(value)}`);
}

/**
 * A number: an integer unless it is a float -- wrapped, or plain with a
 * fraction -- and infinity as a tagged float, which has no literal.
 * @param {number} n
 * @param {boolean} [isFloat] -- whether the pipeline held it as a float
 * @returns {unknown}
 */
function encodeNumber(n, isFloat = false) {
  if (n === Infinity) return tagged('casc.float', 'inf');
  if (n === -Infinity) return tagged('casc.float', '-inf');
  if (Number.isNaN(n)) throw new TypeError('no typed form for NaN');
  if (!isFloat && Number.isInteger(n)) return { integer: BigInt(n).toString() };
  return { float: formatFloat(n) };
}

/**
 * Orders two keys by their UTF-8 bytes, as Elixir sorts binaries: a JS
 * sort compares UTF-16 units, which order some characters differently.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * A tuple tagged with a dotted keyword.
 * @param {string} tag
 * @param {...unknown} items
 * @returns {{tuple: unknown[]}}
 */
function tagged(tag, ...items) {
  return { tuple: [{ keyword: tag }, ...items] };
}

/**
 * The answer to one case. A crash is this implementation's failure on
 * this case, answered as such: the suite reports it as a disagreement
 * rather than losing every other case's answer with it.
 * @param {ConformanceCase} asked
 * @returns {ConformanceResult}
 */
function result(asked) {
  const { id } = asked;
  if (asked.operation !== 'load') {
    return { id, error: `unknown operation: ${asked.operation === undefined ? 'nil' : JSON.stringify(asked.operation)}` };
  }
  try {
    return { id, result: encode(loadDocument(/** @type {string} */ (asked.document))) };
  } catch (err) {
    if (err instanceof CooperError) return { id, error: err.stage };
    return { id, error: `crash: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Loads the document at `file` with the suite's options, as
 * `loadFileSync(file, {cache: false, ...})` does, except that its floats
 * stay `CooperFloat`s (see the module doc).
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function loadDocument(file) {
  const absolute = path.resolve(file);
  let source;
  try {
    source = fs.readFileSync(absolute, 'utf8');
  } catch (err) {
    throw new CooperError(`could not read ${JSON.stringify(file)}: ${formatFsError(err)}`, { stage: 'import', file: absolute, cause: err });
  }
  const opts = loadOptions(path.dirname(absolute));
  const pOpts = {
    env: Dotenv.env(opts),
    root: path.dirname(absolute),
    file: absolute,
    importSchemes: opts.importSchemes,
    resolvers: opts.resolvers,
    tags: opts.tags,
    modules: opts.modules,
  };
  return runSync(
    (function* pipeline() {
      const loaded = yield* loadTree(source, pOpts);
      return (yield* resolveWrapped(loaded, pOpts)).value;
    })()
  );
}

module.exports = { ENV, MODULES, MEM, loadOptions, run, answer, encode };
