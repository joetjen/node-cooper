'use strict';

/**
 * @fileoverview Backs `loadFile`'s default caching -- the port of
 * `Cooper.Cache`. Caches the *pre-resolve* tree (parse, loops, imports,
 * merge) per absolute path and root, and reuses it as long as every file
 * that contributed to it -- the entry file and every transitively imported
 * file -- still has the modification time it had when cached. Reference
 * resolution is never cached: it re-runs against a freshly layered
 * environment on every call, so a `${NAME}` value is always current.
 *
 * Each import's expansion (`import "parts/*.casc"`, braces too) is part of
 * the fingerprint as well, and is expanded again on every hit: a file
 * added where an import looks -- or removed from there -- invalidates the
 * entry just as an edited one does.
 *
 * A `scheme://` import has no file to fingerprint, so its content is only
 * as fresh as the rest of the entry.
 *
 * **What the cached tree's shape depends on is decided when it's
 * populated**: a `${?NAME}` guard, `${NAME}` in an import path, and
 * `${NAME}` in a key. Those refresh when the entry invalidates -- a
 * fingerprinted file changing, `invalidate()`/`clear()`, or, with
 * `watchEnv` (on by default for any file that reads the environment), the
 * next poll after a watched name changes.
 *
 * The cache is also keyed only by path and root: a call that varies
 * `importSchemes`, `resolvers`, or `tags` for the same file should pass
 * `cache: false`.
 *
 * ## Concurrency
 *
 * Concurrent async misses for the same entry share one load rather than
 * each re-parsing.
 *
 * ## Diagnostics channels
 *
 * Two `node:diagnostics_channel` channels -- Node's analog of the
 * reference's `:telemetry` events, free when nothing subscribes:
 *
 * - `cooper:cache:file_changed` -- `{path, root, changedFiles, systemTime}`,
 *   published when a *previously cached* entry is refreshed because a
 *   fingerprinted file changed, appeared where an import looks, or
 *   disappeared from there (never on first population).
 * - `cooper:cache:env_changed` -- `{path, root, changedNames, systemTime}`,
 *   published by the `watchEnv` poll when a watched name changes; the
 *   entry is invalidated too, so the next `loadFile` re-parses against
 *   the current environment.
 *
 * The poll runs every 5 seconds by default (`configure({pollInterval})`),
 * on an unref'd timer that never keeps the process alive, and stops once
 * nothing is watched.
 */

const fs = require('node:fs');
const path = require('node:path');
const diagnostics = require('node:diagnostics_channel');
const Dotenv = require('./dotenv.cjs');
const { expandImport } = require('./pipeline/glob.cjs');

/** @typedef {import('./pipeline/index.cjs').LoadedTree} LoadedTree */
/** @typedef {import('./pipeline/evaluate.cjs').Glob} Glob */

/**
 * @typedef {object} EnvWatch
 * @property {Set<string>} names
 * @property {Record<string, string | undefined>} values -- the baseline
 * @property {import('./dotenv.cjs').DotenvOptions} opts
 */

/**
 * @typedef {object} Entry
 * @property {Array<[string, number | null]>} fingerprint -- each file read, with its mtime
 * @property {Glob[]} globs -- each import's expansion, with the files it matched
 * @property {LoadedTree} loaded
 * @property {EnvWatch | null} envWatch
 */

const channels = {
  fileChanged: diagnostics.channel('cooper:cache:file_changed'),
  envChanged: diagnostics.channel('cooper:cache:env_changed'),
};

/** @type {Map<string, Entry>} */
const entries = new Map();
/** @type {Map<string, Promise<LoadedTree>>} */
const inFlight = new Map();
let pollInterval = 5000;
/** @type {NodeJS.Timeout | null} */
let timer = null;

/**
 * @param {string} file
 * @param {string} root
 * @returns {string}
 */
const keyOf = (file, root) => `${file}\u0000${root}`;

/**
 * @param {string} file
 * @returns {number | null}
 */
function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * What `glob` expands to on disk now, with the same expansion the loader
 * uses -- `null` if expanding it fails (a file removed mid-walk), which
 * never equals a recorded match list and so reloads.
 * @param {Glob} glob
 * @returns {string[] | null}
 */
function expansion(glob) {
  try {
    return expandImport(glob.pattern, glob.root);
  } catch {
    return null;
  }
}

/**
 * @param {string[] | null} a
 * @param {string[]} b
 * @returns {boolean}
 */
const sameFiles = (a, b) => a !== null && a.length === b.length && a.every((f, i) => f === b[i]);

/**
 * The cached tree for `file`/`root`, if present and still fresh. Both
 * halves of the fingerprint are compared against disk: a file edited or
 * deleted changes its mtime, and a file added where an import looks -- or
 * removed from there -- changes what the pattern expands to.
 * @param {string} file -- absolute
 * @param {string} root
 * @returns {LoadedTree | null}
 */
function fetch(file, root) {
  const entry = entries.get(keyOf(file, root));
  if (!entry) return null;
  const fresh = entry.fingerprint.every(([f, m]) => mtime(f) === m) && entry.globs.every((g) => sameFiles(expansion(g), g.files));
  return fresh ? entry.loaded : null;
}

/**
 * @param {string} file
 * @param {string} root
 * @param {LoadedTree} loaded
 */
function store(file, root, loaded) {
  const key = keyOf(file, root);
  const previous = entries.get(key);
  /** @type {Array<[string, number | null]>} */
  const fingerprint = [...loaded.loadedFiles].map((f) => [f, mtime(f)]);
  entries.set(key, { fingerprint, globs: loaded.loadedGlobs, loaded, envWatch: previous?.envWatch ?? null });
  if (previous && channels.fileChanged.hasSubscribers) {
    // Only files are named: one a glob gained or lost already appears in,
    // or disappears from, the files read.
    const before = new Map(previous.fingerprint);
    const after = new Map(fingerprint);
    const changedFiles = [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f)).sort();
    channels.fileChanged.publish({ path: file, root, changedFiles, systemTime: Date.now() });
  }
}

/**
 * Returns the fresh cached tree, or loads, stores, and returns it.
 * @param {string} file
 * @param {string} root
 * @param {() => LoadedTree} load
 * @returns {LoadedTree}
 */
function getOrLoadSync(file, root, load) {
  const cached = fetch(file, root);
  if (cached) return cached;
  const loaded = load();
  store(file, root, loaded);
  return loaded;
}

/**
 * Like `getOrLoadSync`, with concurrent misses for the same entry
 * coalesced into one load.
 * @param {string} file
 * @param {string} root
 * @param {() => Promise<LoadedTree>} load
 * @returns {Promise<LoadedTree>}
 */
function getOrLoad(file, root, load) {
  const cached = fetch(file, root);
  if (cached) return Promise.resolve(cached);
  const key = keyOf(file, root);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = load()
    .then((loaded) => {
      store(file, root, loaded);
      return loaded;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/**
 * Starts polling `names` for changes, from `values` as the baseline --
 * which must be exactly what those names resolved to in the load that
 * just happened, not recomputed later. A no-op for an empty set or a
 * missing entry.
 * @param {string} file
 * @param {string} root
 * @param {Set<string>} names
 * @param {Record<string, string | undefined>} values
 * @param {import('./dotenv.cjs').DotenvOptions} opts
 */
function watchEnv(file, root, names, values, opts) {
  const entry = entries.get(keyOf(file, root));
  if (!entry || names.size === 0) return;
  // Every option that decides the layering is kept: keeping fewer would
  // make the poll read a different environment than the load had --
  // another directory's `.env`, or the files in the other order.
  const { env, dotenv, dotenvEnv, dotenvFiles, dotenvDir, dotenvOverride } = opts;
  // A name already watched keeps its original baseline: re-baselining on
  // every cache hit would swallow a change that lands between two loads,
  // leaving a `${?NAME}` decision baked into the cached tree stale forever.
  const baseline = { ...values, ...(entry.envWatch?.values ?? {}) };
  const watched = new Set([...(entry.envWatch?.names ?? []), ...names]);
  entry.envWatch = { names: watched, values: baseline, opts: { env, dotenv, dotenvEnv, dotenvFiles, dotenvDir, dotenvOverride } };
  ensurePolling();
}

function ensurePolling() {
  if (timer !== null) return;
  timer = setInterval(poll, pollInterval);
  timer.unref();
}

function poll() {
  let watching = 0;
  for (const [key, entry] of entries) {
    if (!entry.envWatch) continue;
    watching++;
    const { names, values, opts } = entry.envWatch;
    let current;
    try {
      current = Dotenv.env(opts);
    } catch {
      continue;
    }
    const changedNames = [...names].filter((name) => current[name] !== values[name]).sort();
    if (changedNames.length === 0) continue;
    entries.delete(key);
    watching--;
    if (channels.envChanged.hasSubscribers) {
      const [file, root] = key.split('\u0000');
      channels.envChanged.publish({ path: file, root, changedNames, systemTime: Date.now() });
    }
  }
  if (watching === 0) stopPolling();
}

function stopPolling() {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/**
 * Removes every cached entry for `file` (any root).
 * @param {string} file
 */
function invalidate(file) {
  const absolute = path.resolve(file);
  for (const key of entries.keys()) if (key.startsWith(`${absolute}\u0000`)) entries.delete(key);
}

/** Removes every cached entry and stops polling. */
function clear() {
  entries.clear();
  stopPolling();
}

/**
 * @param {{pollInterval?: number}} options -- `pollInterval` in milliseconds (default 5000)
 */
function configure(options) {
  if (options.pollInterval !== undefined) {
    if (!(options.pollInterval > 0)) throw new RangeError('pollInterval must be a positive number of milliseconds');
    pollInterval = options.pollInterval;
    if (timer !== null) {
      stopPolling();
      ensurePolling();
    }
  }
}

/** @returns {number} how many entries are cached */
function size() {
  return entries.size;
}

module.exports = {
  fetch,
  getOrLoad,
  getOrLoadSync,
  watchEnv,
  invalidate,
  clear,
  configure,
  size,
  poll,
  channels,
  CHANNEL_FILE_CHANGED: 'cooper:cache:file_changed',
  CHANNEL_ENV_CHANGED: 'cooper:cache:env_changed',
};
