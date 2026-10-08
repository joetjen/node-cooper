'use strict';

/**
 * @fileoverview Public entry point. Loads CASC config files
 * (`guides/casc/CASC.md`) into native JS values -- plain objects (string
 * keys), arrays, `Symbol.for(...)` atoms, real `Tuple`s (never arrays,
 * CASC.md §6.11), and `Secret`-wrapped values for every `*key`-prefixed
 * secret.
 *
 * This is a port of `cooper` (Elixir, on Hex.pm), the reference
 * implementation; see the README's "Other language implementations".
 *
 * Every load runs one pipeline: lex + parse (`grammar/`) -> evaluate
 * statements, expanding `for` loops and splicing imports in place
 * (`pipeline/evaluate.cjs`, `loop.cjs`, `loader.cjs`) -> resolve
 * interpolated keys -> merge, honoring `~`/`+`/`-` and wrapping secrets
 * (`merge.cjs`) -> resolve every `@{}`/`${}`/`%{}`/`!{}`/`!Name()`
 * reference (`resolver.cjs`). `loadFile` caches everything before that last
 * step (`cache.cjs`).
 *
 * ## Sync and async
 *
 * Each function comes in two flavours. `loadFile`/`loadString` return a
 * `Promise` and accept registered resolvers, tags, and import-scheme
 * loaders that are themselves asynchronous (a secrets manager is a network
 * call). `loadFileSync`/`loadStringSync` return the value directly, for
 * the common case of plain files loaded at startup; a callback returning a
 * `Promise` there is an error naming it. The Elixir implementation has a
 * single, blocking flavour.
 *
 * ## Errors
 *
 * Every failure is a `CooperError` (thrown, or the rejection), with a
 * `stage` naming the pipeline stage -- `lexer`, `parser`, `action`, `loop`,
 * `import`, `merge`, `resolve`, or `dotenv` -- the same stage names the
 * reference uses.
 *
 * ## A note on atoms
 *
 * CASC atoms (`level = info`, CASC.md §6.4) load as `Symbol.for(name)`, the
 * closest JS analog to an Elixir atom. Like an atom, a registered symbol is
 * never garbage-collected: fine for a fixed, trusted set of config files,
 * worth knowing before pointing `cooper` at config an untrusted party can
 * write.
 */

const fs = require('node:fs');
const path = require('node:path');
const version = require('./version.cjs');
const values = require('./values/index.cjs');
const CooperError = require('./error.cjs');
const Dotenv = require('./dotenv.cjs');
const Cache = require('./cache.cjs');
const { runSync, runAsync } = require('./pipeline/effects.cjs');
const { loadTree, resolveLoaded } = require('./pipeline/index.cjs');
const { formatFsError } = require('./pipeline/loader.cjs');

/**
 * A function registered for `!{name:payload}` (CASC.md §7.4): receives the
 * payload verbatim, returns the value (or a `Promise` of it, with the async
 * API). Throw to fail the load.
 * @typedef {(payload: string) => unknown} ResolverFn
 */

/**
 * A function registered for `!Name(arg)` (CASC.md §7.5): receives the
 * resolved argument, returns the value (or a `Promise` of it, with the
 * async API). Throw to fail the load. A float in the argument, nested
 * ones included, is a `CooperFloat`, so a tag can tell `2.0` from `2`;
 * return one to yield a float.
 * @typedef {(arg: any) => unknown} TagFn
 */

/**
 * A function registered for `import "scheme://rest"` (CASC.md §9.3):
 * receives everything after `scheme://` and returns the imported CASC
 * source text (or a `Promise` of it, with the async API).
 * @typedef {(rest: string) => string | Promise<string>} ImportSchemeFn
 */

/**
 * What the `modules` option maps a `!module("Name")` name to. A string is
 * a Node module specifier (`'./lib/payments/stripe.js'`, `'node:crypto'`,
 * `'@acme/pkg'`, a `file:` URL); a relative one resolves against
 * `process.cwd()`, because the mapping is application code, not part of
 * the config. Nothing is imported at load time: `ModuleRef#load()` imports
 * it on request. Any other value (an already-imported module, a class) is
 * handed back by `ModuleRef#load()` as is.
 * @typedef {unknown} ModuleTarget
 */

/**
 * @typedef {object} LoadOptions
 * @property {Record<string, string>} [env] -- an override layer for `${...}`, on top of `process.env` and `.env` files (not a replacement for them)
 * @property {boolean} [dotenv] -- load `.env` files (default `true`); see `Dotenv`
 * @property {string | null} [dotenvEnv] -- the `<env>` in `.env.<env>` (default `COOPER_ENV`)
 * @property {string[]} [dotenvFiles] -- replaces the default `.env` file list
 * @property {string} [dotenvDir] -- the directory `.env` files are read from, and the base of a relative `dotenvFiles` entry (default: the project root, the nearest `package.json` above `process.cwd()`)
 * @property {boolean} [dotenvOverride] -- let `.env` files outrank `process.env` (default `false`)
 * @property {string} [root] -- directory a bare `import` resolves against; `loadFile` uses the file's own directory, `loadString` `process.cwd()`
 * @property {string} [file] -- `loadString` only: the path the source came from, for private-variable scoping and import-cycle detection
 * @property {Record<string, ResolverFn> | Map<string, ResolverFn>} [resolvers] -- one function per `!{name:...}`
 * @property {Record<string, TagFn> | Map<string, TagFn>} [tags] -- one function per `!Name(...)` beyond the built-ins (a same-named entry replaces a built-in)
 * @property {Record<string, ImportSchemeFn>} [importSchemes] -- one loader per `import "scheme://..."`
 * @property {Record<string, ModuleTarget> | Map<string, ModuleTarget>} [modules] -- what each `!module("Name")` means (CASC.md §7.5), by the name exactly as written; a name it does not hold is a load error
 * @property {boolean} [cache] -- `loadFile` only: use the cache (default `true`)
 * @property {boolean} [watchEnv] -- `loadFile` only: poll the environment names this load read for changes (default: whether it read any)
 */

/**
 * @param {LoadOptions} opts
 * @param {Record<string, string>} env
 * @param {string} root
 * @param {string | undefined} file
 * @returns {import('./pipeline/index.cjs').PipelineOptions}
 */
function pipelineOptions(opts, env, root, file) {
  return { env, root, file, importSchemes: opts.importSchemes, resolvers: opts.resolvers, tags: opts.tags, modules: opts.modules };
}

/**
 * @param {string} source
 * @param {LoadOptions} opts
 * @returns {import('./pipeline/effects.cjs').Pipeline<Record<string, unknown>>}
 */
function* stringPipeline(source, opts) {
  const env = Dotenv.env(opts);
  const root = path.resolve(opts.root ?? process.cwd());
  const pOpts = pipelineOptions(opts, env, root, opts.file);
  const loaded = yield* loadTree(source, pOpts);
  return (yield* resolveLoaded(loaded, pOpts)).value;
}

/**
 * @param {string} file
 * @returns {{absolute: string, source: string}}
 */
function readEntry(file) {
  const absolute = path.resolve(file);
  try {
    return { absolute, source: fs.readFileSync(absolute, 'utf8') };
  } catch (err) {
    throw new CooperError(`could not read ${JSON.stringify(file)}: ${formatFsError(err)}`, { stage: 'import', file: absolute, cause: err });
  }
}

/**
 * Resolves a cached (or freshly loaded) tree and, when watching, registers
 * every environment name the load depends on.
 * @param {import('./pipeline/index.cjs').LoadedTree} loaded
 * @param {import('./pipeline/index.cjs').PipelineOptions} pOpts
 * @param {LoadOptions} opts
 * @returns {import('./pipeline/effects.cjs').Pipeline<Record<string, unknown>>}
 */
function* resolveCached(loaded, pOpts, opts) {
  const { value, envNames } = yield* resolveLoaded(loaded, pOpts);
  const names = new Set([...envNames, ...loaded.parseEnvNames]);
  if (opts.watchEnv ?? names.size > 0) {
    /** @type {Record<string, string | undefined>} */
    const baseline = {};
    for (const name of names) baseline[name] = pOpts.env[name];
    // The default `.env` directory is pinned to the one this load used:
    // the poll must re-read the same files even if the process has
    // changed directory since.
    const dotenvDir = path.resolve(opts.dotenvDir ?? Dotenv.projectRoot());
    Cache.watchEnv(/** @type {string} */ (pOpts.file), pOpts.root, names, baseline, { ...opts, dotenvDir });
  }
  return value;
}

/**
 * @param {unknown} err
 * @returns {CooperError}
 */
const asCooperError = (err) => CooperError.wrap(err, 'unknown');

/**
 * Loads CASC source text -- the same pipeline as `loadFile`, for a source
 * that isn't (yet, or ever) in a file. Never cached. A bare `import` needs
 * a meaningful `root` (default `process.cwd()`).
 *
 * @param {string} source -- a complete CASC document, version header included
 * @param {LoadOptions} [opts]
 * @returns {Promise<Record<string, any>>}
 */
async function loadString(source, opts = {}) {
  try {
    return await runAsync(stringPipeline(source, opts));
  } catch (err) {
    throw asCooperError(err);
  }
}

/**
 * Synchronous `loadString`. Every registered resolver, tag, and import
 * scheme must return its value directly.
 *
 * @param {string} source
 * @param {LoadOptions} [opts]
 * @returns {Record<string, any>}
 */
function loadStringSync(source, opts = {}) {
  try {
    return runSync(stringPipeline(source, opts));
  } catch (err) {
    throw asCooperError(err);
  }
}

/**
 * Reads and loads the CASC file at `file`. Bare imports resolve relative to
 * its directory; an import cycle back to it is caught on the first repeat.
 *
 * Caches the pre-resolve tree by default (see `Cache`), keyed by the
 * modification times of the file and everything it imports; `${...}`
 * values are re-resolved on every call regardless. Pass `cache: false` for
 * a guaranteed-fresh parse.
 *
 * @param {string} file
 * @param {LoadOptions} [opts]
 * @returns {Promise<Record<string, any>>}
 */
async function loadFile(file, opts = {}) {
  try {
    const { absolute, source } = readEntry(file);
    const root = path.resolve(opts.root ?? path.dirname(absolute));
    if (opts.cache === false) return await runAsync(stringPipeline(source, { ...opts, root, file: absolute }));
    const env = Dotenv.env(opts);
    const pOpts = pipelineOptions(opts, env, root, absolute);
    const loaded = await Cache.getOrLoad(absolute, root, () => runAsync(loadTree(source, pOpts)));
    return await runAsync(resolveCached(loaded, pOpts, opts));
  } catch (err) {
    throw asCooperError(err);
  }
}

/**
 * Synchronous `loadFile`. Every registered resolver, tag, and import scheme
 * must return its value directly.
 *
 * @param {string} file
 * @param {LoadOptions} [opts]
 * @returns {Record<string, any>}
 */
function loadFileSync(file, opts = {}) {
  try {
    const { absolute, source } = readEntry(file);
    const root = path.resolve(opts.root ?? path.dirname(absolute));
    if (opts.cache === false) return runSync(stringPipeline(source, { ...opts, root, file: absolute }));
    const env = Dotenv.env(opts);
    const pOpts = pipelineOptions(opts, env, root, absolute);
    const loaded = Cache.getOrLoadSync(absolute, root, () => runSync(loadTree(source, pOpts)));
    return runSync(resolveCached(loaded, pOpts, opts));
  } catch (err) {
    throw asCooperError(err);
  }
}

/**
 * The cache behind `loadFile`/`loadFileSync`.
 */
const CacheAPI = {
  invalidate: Cache.invalidate,
  clear: Cache.clear,
  configure: Cache.configure,
  size: Cache.size,
  CHANNEL_FILE_CHANGED: Cache.CHANNEL_FILE_CHANGED,
  CHANNEL_ENV_CHANGED: Cache.CHANNEL_ENV_CHANGED,
};

/**
 * The environment layering `${...}` reads from (`.env` files, then
 * `process.env`, then the `env` option).
 */
const DotenvAPI = { env: Dotenv.env, parse: Dotenv.parseDotenv, projectRoot: Dotenv.projectRoot };

module.exports = {
  version,
  loadFile,
  loadFileSync,
  loadString,
  loadStringSync,
  CooperError,
  Cache: CacheAPI,
  Dotenv: DotenvAPI,
  ...values,
};
