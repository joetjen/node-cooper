'use strict';

/**
 * @fileoverview Resolves and loads an `import "..."` statement (CASC.md
 * §5.1), called inline from the evaluator at the point the import is
 * reached -- the port of `Cooper.Loader`.
 *
 * - A bare path resolves relative to the *importing* file's own directory;
 *   brace and glob patterns expand against the filesystem (`glob.cjs`),
 *   matches loading in lexicographic order.
 * - A `scheme://` path goes to the loader registered for that scheme
 *   (`importSchemes`), which returns the imported CASC source; an
 *   unregistered scheme is a load-time error naming it (§9.4).
 * - A path may interpolate `${NAME}`/`${NAME:default}`, read from the
 *   environment while parsing; nothing else is available yet.
 *
 * Each imported file runs through the whole per-file pipeline before its
 * entries are spliced into the importer's. Its public variables join the
 * shared environment; its private ones stay filed under its own scope.
 */

const fs = require('node:fs');
const path = require('node:path');
const CooperError = require('../error.cjs');
const { InterpText, EnvRef } = require('./nodes.cjs');
const { call } = require('./effects.cjs');
const { expandImport } = require('./glob.cjs');
const { display } = require('./display.cjs');

/** @typedef {import('./evaluate.cjs').Context} Context */
/** @typedef {import('./nodes.cjs').Entry} Entry */
/** @template T @typedef {import('./effects.cjs').Pipeline<T>} Pipeline */

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([\s\S]+)$/;

/**
 * @param {string} message
 * @returns {CooperError}
 */
const importError = (message) => new CooperError(message, { stage: 'import' });

/**
 * Turns a Node fs error into the short reason Erlang's
 * `:file.format_error/1` gives, so messages match the reference.
 * @param {unknown} err
 * @returns {string}
 */
function formatFsError(err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
  /** @type {Record<string, string>} */
  const reasons = { ENOENT: 'no such file or directory', EACCES: 'permission denied', EISDIR: 'illegal operation on a directory' };
  return (code && reasons[code]) || (err instanceof Error ? err.message : String(err));
}

/**
 * @param {unknown} pathValue -- the import statement's evaluated string
 * @param {Context} ctx
 * @returns {Pipeline<Entry[]>}
 */
function* loadImport(pathValue, ctx) {
  const target = interpolatePath(pathValue, ctx);
  const scheme = SCHEME.exec(target);
  if (scheme) return yield* loadScheme(scheme[1], scheme[2], ctx);

  const files = expandImport(target, ctx.root);
  // The expansion itself is recorded beside the files it found, so the
  // cache can expand the pattern again and see a file that now matches --
  // or no longer does. Fingerprinting only the files read, as this once
  // did, noticed one edited or deleted, never one added where a glob looks.
  ctx.loadedGlobs.push({ root: ctx.root, pattern: target, files });
  if (files.length === 0) throw importError(`import ${JSON.stringify(target)} matched no files (searched under ${ctx.root})`);
  /** @type {Entry[]} */
  const entries = [];
  for (const file of files) entries.push(...(yield* loadFile(file, ctx)));
  return entries;
}

/**
 * Builds an import path from an interpolated string, at parse time. Only
 * `${NAME}` and `${NAME:default}` are permitted; unset and empty are
 * treated alike, and an unset name with no default is an error, since a
 * path that silently became `env/.casc` would import the wrong file.
 * @param {unknown} pathValue
 * @param {Context} ctx
 * @returns {string}
 */
function interpolatePath(pathValue, ctx) {
  if (typeof pathValue === 'string') return pathValue;
  if (!(pathValue instanceof InterpText)) {
    throw importError('import path must be a string, or a string interpolating only "${NAME}" references');
  }
  return pathValue.segments
    .map((segment) => {
      if (typeof segment === 'string') return segment;
      if (!(segment instanceof EnvRef) || typeof segment.name !== 'string' || segment.index !== null || segment.list || segment.filters.length > 0 || (segment.suffix !== null && segment.suffix.kind !== 'default')) {
        throw importError('an import path may interpolate only "${NAME}" or "${NAME:default}"');
      }
      ctx.parseEnvNames.add(segment.name);
      const value = Object.hasOwn(ctx.env, segment.name) ? ctx.env[segment.name] : undefined;
      if (value !== undefined && value !== '') return value;
      if (segment.suffix?.kind === 'default') return display(segment.suffix.value);
      throw importError(`import path references ${JSON.stringify(segment.name)}, which is unset and has no default`);
    })
    .join('');
}

/**
 * @param {string} scheme
 * @param {string} rest
 * @param {Context} ctx
 * @returns {Pipeline<Entry[]>}
 */
function* loadScheme(scheme, rest, ctx) {
  const loader = Object.hasOwn(ctx.importSchemes, scheme) ? ctx.importSchemes[scheme] : undefined;
  if (typeof loader !== 'function') throw importError(`unregistered import scheme ${JSON.stringify(scheme)}`);
  const id = `${scheme}://${rest}`;
  if (ctx.importing.includes(id)) throw importError(`import cycle detected: ${[...ctx.importing, id].join(' -> ')}`);
  let source;
  try {
    source = yield* call(loader, rest, `import scheme "${scheme}"`, 'import');
  } catch (err) {
    if (err instanceof CooperError) throw err;
    throw new CooperError(`${scheme}:// loader failed for ${JSON.stringify(rest)}: ${err instanceof Error ? err.message : String(err)}`, {
      stage: 'import',
      cause: err,
    });
  }
  if (typeof source !== 'string') {
    throw importError(`${scheme}:// loader for ${JSON.stringify(rest)} returned ${typeof source}, not CASC source text`);
  }
  // A scheme source has no directory of its own; its bare imports resolve
  // against the importer's.
  return yield* loadSource(id, source, ctx, ctx.root);
}

/**
 * @param {string} file -- absolute
 * @param {Context} ctx
 * @returns {Pipeline<Entry[]>}
 */
function* loadFile(file, ctx) {
  if (ctx.importing.includes(file)) {
    throw importError(`import cycle detected: ${[...ctx.importing, file].join(' -> ')}`);
  }
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw importError(`could not read import ${JSON.stringify(file)}: ${formatFsError(err)}`);
  }
  ctx.loadedFiles.add(file);
  return yield* loadSource(file, source, ctx, path.dirname(file));
}

/**
 * Runs one imported source through the per-file pipeline with a fresh
 * context: nothing is inherited at parse time except what has to cross
 * files (schemes, env, cycle detection, the shared public variables), and
 * the imported file's public variables flow back into the importer.
 * @param {string} id -- the file path, or `scheme://rest`
 * @param {string} source
 * @param {Context} ctx
 * @param {string} root
 * @returns {Pipeline<Entry[]>}
 */
function* loadSource(id, source, ctx, root) {
  const { evaluateSource, scopeId } = require('./evaluate.cjs');
  /** @type {Context} */
  const sub = {
    scope: id.includes('://') ? id : scopeId(id),
    file: id.includes('://') ? undefined : id,
    root,
    importSchemes: ctx.importSchemes,
    importing: [...ctx.importing, id],
    loadedFiles: ctx.loadedFiles,
    loadedGlobs: ctx.loadedGlobs,
    env: ctx.env,
    parseEnvNames: ctx.parseEnvNames,
    publicVars: new Map(),
    privateVars: new Map(),
    privateByScope: ctx.privateByScope,
  };
  const entries = yield* evaluateSource(source, sub);
  for (const [name, value] of sub.publicVars) ctx.publicVars.set(name, value);
  return entries;
}

module.exports = { loadImport, formatFsError };
