'use strict';

/**
 * @fileoverview The pipeline end to end, split at the point the cache
 * splits it (the port of `Cooper.Grammar.run_tree*` plus the resolve step
 * in `Cooper.load_*`):
 *
 * 1. `loadTree` -- parse, expand loops, splice imports (`evaluate.cjs`),
 *    resolve interpolated keys, merge (`merge.cjs`). Its result depends on
 *    the files and on the few environment names read while parsing
 *    (`${?NAME}` guards, `${NAME}` in import paths and keys), so it is what
 *    `loadFile` caches.
 * 2. `resolveLoaded` -- resolve every remaining reference (`resolver.cjs`)
 *    against the current environment. Never cached.
 */

const path = require('node:path');
const { unwrapFloats } = require('../values/float.cjs');
const { evaluateSource, scopeId } = require('./evaluate.cjs');
const { assemble } = require('./merge.cjs');
const { Resolver } = require('./resolver.cjs');

/** @template T @typedef {import('./effects.cjs').Pipeline<T>} Pipeline */
/** @typedef {import('./nodes.cjs').Entry} Entry */

/**
 * @typedef {object} PipelineOptions
 * @property {Record<string, string>} env -- the already-layered environment
 * @property {string} root
 * @property {string} [file] -- absolute path of the entry source, if it has one
 * @property {Record<string, (rest: string) => unknown>} [importSchemes]
 * @property {Record<string, Function> | Map<string, Function>} [resolvers]
 * @property {Record<string, Function> | Map<string, Function>} [tags]
 * @property {Record<string, unknown> | Map<string, unknown>} [modules] -- what each `!module("Name")` means
 */

/**
 * The merged-but-unresolved result of step 1.
 * @typedef {object} LoadedTree
 * @property {Record<string, unknown>} tree
 * @property {Map<string, unknown>} publicVars
 * @property {Map<string, Map<string, unknown>>} privateByScope
 * @property {Set<string>} loadedFiles -- every real file read, entry included
 * @property {import('./evaluate.cjs').Glob[]} loadedGlobs -- every filesystem import's expansion
 * @property {Set<string>} parseEnvNames -- environment names the tree's shape depends on
 */

/**
 * @param {string} source
 * @param {PipelineOptions} opts
 * @returns {Pipeline<LoadedTree>}
 */
function* loadTree(source, opts) {
  const file = opts.file === undefined ? undefined : path.resolve(opts.file);
  /** @type {import('./evaluate.cjs').Context} */
  const ctx = {
    scope: scopeId(file),
    file,
    root: opts.root,
    importSchemes: opts.importSchemes ?? {},
    importing: file === undefined ? [] : [file],
    loadedFiles: new Set(file === undefined ? [] : [file]),
    loadedGlobs: [],
    env: opts.env,
    parseEnvNames: new Set(),
    publicVars: new Map(),
    privateVars: new Map(),
    privateByScope: new Map(),
  };
  const entries = yield* evaluateSource(source, ctx);

  // Interpolated keys (`"@{name}" = 1`) are resolved now, before merge,
  // since merge needs real keys. Only what exists before the tree does may
  // appear in one: variables, the environment, resolvers, and tags.
  const keys = new Resolver({ ...opts, tree: null, publicVars: ctx.publicVars, privateByScope: ctx.privateByScope });
  /** @type {Entry[]} */
  const resolved = [];
  for (const entry of entries) {
    if (entry.kind === 'var' || entry.path.every((s) => typeof s === 'string')) {
      resolved.push(entry);
      continue;
    }
    const keyPath = [];
    for (const segment of entry.path) keyPath.push(typeof segment === 'string' ? segment : yield* keys.resolveKey(segment));
    resolved.push({ ...entry, path: keyPath });
  }
  for (const name of keys.envNames) ctx.parseEnvNames.add(name);

  return {
    tree: assemble(resolved),
    publicVars: ctx.publicVars,
    privateByScope: ctx.privateByScope,
    loadedFiles: ctx.loadedFiles,
    loadedGlobs: ctx.loadedGlobs,
    parseEnvNames: ctx.parseEnvNames,
  };
}

/**
 * Step 2: resolves a loaded tree against the environment in `opts`.
 * @param {LoadedTree} loaded
 * @param {PipelineOptions} opts
 * @returns {Pipeline<{value: Record<string, unknown>, envNames: Set<string>}>}
 */
function* resolveLoaded(loaded, opts) {
  const resolver = new Resolver({ ...opts, tree: loaded.tree, publicVars: loaded.publicVars, privateByScope: loaded.privateByScope });
  // The pipeline's internal floats become plain numbers here, the one
  // place a resolved tree leaves it (values/float.cjs).
  const value = /** @type {Record<string, unknown>} */ (unwrapFloats(yield* resolver.resolve(loaded.tree)));
  return { value, envNames: resolver.envNames };
}

module.exports = { loadTree, resolveLoaded };
