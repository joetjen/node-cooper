'use strict';

/**
 * @fileoverview Builds the environment `${...}` references (CASC.md §7.2)
 * read from -- the port of `Cooper.Dotenv`. Called on every load, cached
 * or not, so a `${NAME}` value is always current.
 *
 * ## Layering
 *
 * Five layers, later winning:
 *
 * 1. `.env`
 * 2. `.env.<env>` -- `<env>` is the `dotenvEnv` option, else `COOPER_ENV`
 *    (see below) as `process.env`, the `env` option and the base `.env`
 *    file set it -- so `.env.dev`, `.env.staging`, `.env.test` and
 *    `.env.prod` in every Cooper, matching `env/${COOPER_ENV}.casc`.
 *    Naming it by `NODE_ENV`, as this once did, read `.env.development`
 *    beside documents that read `dev`. `dotenvEnv: null` drops the layer
 * 3. `.env.local`
 * 4. `process.env` -- **the real environment outranks every file**: a
 *    deployment sets variables in the environment it controls, and a file
 *    in the working directory must not silently beat them (what Node's own
 *    `dotenv` does too)
 * 5. the `env` option -- always the final override, but only for the names
 *    it defines; every other name still falls through to the layers below
 *
 * `dotenvOverride: true` puts the files above `process.env` instead.
 * `dotenv: false` drops layers 1-3. `dotenvFiles` replaces the list of
 * files in layers 1-3. Every file is optional and resolved against
 * `dotenvDir`, which defaults to the **project root** -- deliberately not
 * `root` (the config file's directory): `.env` files live at the project
 * root, regardless of where the CASC file sits or where the process was
 * started. The project root is the directory of the nearest `package.json`
 * walking up from `process.cwd()`, else `process.cwd()` itself (see
 * `projectRoot`). An absolute `dotenvFiles` entry is used as it is.
 *
 * ## File format
 *
 * The format the reference's `dotenvy` dependency reads, hand-rolled here
 * to keep zero runtime dependencies: `KEY=value` lines with an optional
 * `export ` prefix, `#` comments, unquoted values (trimmed, `# comment`
 * ends them), `'single'` (literal) and `"double"` (escapes `\n` `\r` `\t`
 * `\f` `\b` `\"` `\'` `\\` `\uXXXX`) quoted values, `'''`/`"""` multi-line
 * heredocs, and `${NAME}` interpolation of anything defined in an earlier
 * layer or earlier in the same file. One deliberate omission: `$(command)`
 * is kept as literal text rather than executed -- loading configuration
 * should never run programs.
 *
 * ## `COOPER_ENV`
 *
 * The one name a document reads the current environment by, in every
 * Cooper implementation (CASC.md §7.2): `import "env/${COOPER_ENV}.casc"`.
 * Every layer above is consulted first, so a real `COOPER_ENV` -- in the
 * environment, a `.env` file, or `env` -- always wins. Unset or empty, it
 * falls back to Node's own name for the same thing: `NODE_ENV` from those
 * same layers, else `"dev"`. Every Cooper names its environments `dev`,
 * `staging`, `test` and `prod`, so in that fallback only, the host's own
 * spellings are mapped onto them through the one table CASC.md §7.2 gives
 * every implementation -- `development` and `local` -> `dev`, `testing` ->
 * `test`, `production` -> `prod`, exact and case-sensitive -- and one
 * `env/dev.casc` serves every implementation, `NODE_ENV=development` and
 * all. Any other `NODE_ENV` (`staging`, `qa`, ...) is passed through as
 * is, and a real `COOPER_ENV` is never mapped: whoever set it chose the
 * name. `NODE_ENV` itself is left alone. Read before `.env.<env>`, the
 * same value names that file (see "Layering"). Because the cache's `watchEnv` poll recomputes this same map, a
 * changed `NODE_ENV` is seen as a changed `COOPER_ENV`.
 */

const fs = require('node:fs');
const path = require('node:path');
const CooperError = require('./error.cjs');

/**
 * @typedef {object} DotenvOptions
 * @property {Record<string, string>} [env] -- final override layer
 * @property {boolean} [dotenv] -- load `.env` files at all (default `true`)
 * @property {string | null} [dotenvEnv] -- the `<env>` in `.env.<env>` (default `COOPER_ENV`)
 * @property {string[]} [dotenvFiles] -- replaces the default file list
 * @property {string} [dotenvDir] -- where the files are read from, and the base of a relative `dotenvFiles` entry (default `projectRoot()`)
 * @property {boolean} [dotenvOverride] -- files outrank `process.env` (default `false`)
 */

/** @type {Record<string, string>} */
const ESCAPES = { n: '\n', r: '\r', t: '\t', f: '\f', b: '\b', '"': '"', "'": "'", '\\': '\\' };

/**
 * Parses one `.env` file's contents on top of `vars` (what interpolation
 * can see), returning the merged map.
 * @param {string} contents
 * @param {Record<string, string>} vars
 * @returns {Record<string, string>}
 * @throws {Error} with a message naming the problem
 */
function parseDotenv(contents, vars = {}) {
  const src = contents.replace(/\r\n/g, '\n');
  /** @type {Record<string, string>} */
  const out = { ...vars };
  let i = 0;

  /** Text up to end of line (consumed), a `#` ending it early. */
  const restOfLine = () => {
    let text = '';
    while (i < src.length && src[i] !== '\n' && src[i] !== '#') text += src[i++];
    while (i < src.length && src[i] !== '\n') i++;
    i++;
    return text;
  };

  for (;;) {
    // ---- find a key
    let acc = '';
    let key = null;
    while (key === null) {
      if (i >= src.length) {
        if (acc.trim() !== '') throw new Error('Invalid syntax: variable missing value');
        return out;
      }
      const c = src[i];
      if (c === '#') {
        while (i < src.length && src[i] !== '\n') i++;
        acc = '';
      } else if (c === '=') {
        i++;
        const candidate = (acc.trimStart().startsWith('export ') ? acc.trimStart().slice(7) : acc).trim();
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(candidate)) throw new Error(`Invalid variable name syntax: ${JSON.stringify(acc)}`);
        key = candidate;
      } else if (c === '\n') {
        if (acc.trim() !== '') throw new Error(`Invalid syntax for line. No equals sign for key: ${JSON.stringify(acc)}`);
        i++;
      } else {
        acc += c;
        i++;
      }
    }

    // ---- find its value
    let value = '';
    /** @type {string | null} */
    let stop = null;
    let interpolate = true;
    for (;;) {
      if (stop === null && (src.startsWith("'''", i) || src.startsWith('"""', i))) {
        if (value.trim() !== '') throw new Error(`Key: ${key}: Improper syntax before opening heredoc: ${JSON.stringify(value)}`);
        stop = src.slice(i, i + 3);
        interpolate = stop === '"""';
        i += 3;
        if (restOfLine().trim() !== '') {
          throw new Error(`Key: ${key}: heredoc allows only zero or more whitespace characters followed by a new line after ${stop}`);
        }
        value = '';
        continue;
      }
      if (stop !== null && stop.length === 3 && src.startsWith(stop, i)) {
        i += 3;
        const rest = restOfLine();
        if (rest.trim() !== '') throw new Error(`Invalid syntax following ${JSON.stringify(stop)}: ${JSON.stringify(rest)}`);
        out[key] = value;
        break;
      }
      if (stop === null && (src[i] === '"' || src[i] === "'")) {
        if (value.trim() !== '') throw new Error(`Improper syntax before opening quote: ${JSON.stringify(value)}`);
        stop = src[i];
        interpolate = stop === '"';
        value = '';
        i++;
        continue;
      }
      if (stop === null && (i >= src.length || src[i] === '\n' || src[i] === '#')) {
        out[key] = value.trim();
        if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
        i++;
        break;
      }
      if (interpolate && src.startsWith('${', i)) {
        const close = src.indexOf('}', i + 2);
        if (close < 0) throw new Error('Stop sequence not found: "}"');
        const name = src.slice(i + 2, close).trim();
        if (!Object.hasOwn(out, name)) throw new Error(`Could not interpolate variable \${${name}}: variable undefined.`);
        value += out[name];
        i = close + 1;
        continue;
      }
      if (stop !== null && stop.length === 1 && src[i] === stop) {
        i++;
        const rest = restOfLine();
        if (rest.trim() !== '') throw new Error(`Invalid syntax for key ${key} following ${JSON.stringify(stop)}: ${JSON.stringify(rest)}`);
        out[key] = value;
        break;
      }
      if (interpolate && src[i] === '\\' && i + 1 < src.length) {
        const c = src[i + 1];
        if (c === 'u') {
          const hex = src.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`Invalid unicode format for key ${key}: \\u${hex}`);
          value += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          value += ESCAPES[c] ?? c;
          i += 2;
        }
        continue;
      }
      if (i >= src.length) {
        throw new Error(`Could not parse value for ${JSON.stringify(key)}. Stop sequence not found: ${JSON.stringify(stop)}`);
      }
      value += src[i++];
    }
  }
}

/**
 * Where `.env` files are read from unless `dotenvDir` says otherwise: the
 * directory of the nearest `package.json` walking up from `cwd`, else
 * `cwd` itself. Reading them from the working directory only, as this
 * once did, found none when an application was started from anywhere but
 * its own root (a subdirectory, a test runner, a process manager).
 * @param {string} [cwd] -- where to start (default `process.cwd()`)
 * @returns {string}
 */
function projectRoot(cwd = process.cwd()) {
  const start = path.resolve(cwd);
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

/**
 * The `.env` files to layer, lowest precedence first, as absolute paths.
 * @param {DotenvOptions} opts
 * @returns {string[]}
 */
function dotenvFiles(opts) {
  const dir = opts.dotenvDir ?? projectRoot();
  if (opts.dotenvFiles) return opts.dotenvFiles.map((file) => path.resolve(dir, file));
  const envName = opts.dotenvEnv === undefined ? nameEnv(opts, path.resolve(dir, '.env')) : opts.dotenvEnv;
  return ['.env', ...(envName ? [`.env.${envName}`] : []), '.env.local'].map((file) => path.resolve(dir, file));
}

/**
 * `COOPER_ENV` as it stands before `.env.<env>` is read -- from
 * `process.env`, the `env` option and the base `.env` file, in the order
 * the layering puts them -- which names the file to read next. The files
 * after it cannot name it: they are not read yet.
 * @param {DotenvOptions} opts
 * @param {string} baseFile -- the absolute path of `.env`
 * @returns {string}
 * @throws {CooperError} stage `dotenv`, for a malformed `.env` file
 */
function nameEnv(opts, baseFile) {
  const real = definedOnly(process.env);
  const sources = opts.dotenvOverride ? [real, baseFile] : [baseFile, real];
  return withCooperEnv({ ...layerSources(sources), ...(opts.env ?? {}) }).COOPER_ENV;
}

/**
 * @param {Record<string, string | undefined>} source
 * @returns {Record<string, string>}
 */
function definedOnly(source) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === 'string') out[key] = value;
  return out;
}

/**
 * Host environment names, and the shared ones (`dev`, `staging`, `test`,
 * `prod`) they map onto -- the table CASC.md §7.2 gives every Cooper, so
 * it must stay identical to theirs. Only the `NODE_ENV` fallback consults
 * it.
 * @type {Readonly<Record<string, string>>}
 */
const SHARED_ENV_NAMES = Object.freeze({ development: 'dev', local: 'dev', testing: 'test', production: 'prod' });

/**
 * Guarantees `COOPER_ENV` in a resolved env map: kept when present and
 * non-empty, else `NODE_ENV` (when present and non-empty) mapped onto the
 * shared names, else `"dev"`. See "`COOPER_ENV`" above.
 * @param {Record<string, string>} vars
 * @returns {Record<string, string>}
 */
function withCooperEnv(vars) {
  if (present(vars.COOPER_ENV)) return vars;
  return { ...vars, COOPER_ENV: present(vars.NODE_ENV) ? sharedEnvName(vars.NODE_ENV) : 'dev' };
}

/**
 * `hostEnv` as `COOPER_ENV` spells it: mapped through `SHARED_ENV_NAMES`,
 * anything not in it unchanged. `Object.hasOwn` keeps a `NODE_ENV` such
 * as `constructor` from reaching the prototype.
 * @param {string} hostEnv
 * @returns {string}
 */
function sharedEnvName(hostEnv) {
  return Object.hasOwn(SHARED_ENV_NAMES, hostEnv) ? SHARED_ENV_NAMES[hostEnv] : hostEnv;
}

/**
 * Whether an env value counts as set: an empty string means "unset" for
 * `COOPER_ENV` and its fallback, as in the reference.
 * @param {string | undefined} value
 * @returns {value is string}
 */
function present(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * Resolves the final environment map for `opts`, per the layering above,
 * with `COOPER_ENV` guaranteed.
 * @param {DotenvOptions} [opts]
 * @returns {Record<string, string>}
 * @throws {CooperError} stage `dotenv`, for a malformed `.env` file
 */
function env(opts = {}) {
  return withCooperEnv(layered(opts));
}

/**
 * The five layers merged, later winning -- before `COOPER_ENV` is added.
 * @param {DotenvOptions} opts
 * @returns {Record<string, string>}
 * @throws {CooperError} stage `dotenv`, for a malformed `.env` file
 */
function layered(opts) {
  const real = definedOnly(process.env);
  const overrides = opts.env ?? {};
  if (opts.dotenv === false) return { ...real, ...overrides };

  const files = dotenvFiles(opts);
  return { ...layerSources(opts.dotenvOverride ? [real, ...files] : [...files, real]), ...overrides };
}

/**
 * Merges `sources` in order, later winning: a map as it is, a string as
 * the path of a `.env` file parsed on top of what came before (so it can
 * interpolate it). A missing file is skipped.
 * @param {Array<string | Record<string, string>>} sources
 * @returns {Record<string, string>}
 * @throws {CooperError} stage `dotenv`, for a malformed `.env` file
 */
function layerSources(sources) {
  /** @type {Record<string, string>} */
  let acc = {};
  for (const source of sources) {
    if (typeof source !== 'string') {
      acc = { ...acc, ...source };
      continue;
    }
    let contents;
    try {
      contents = fs.readFileSync(source, 'utf8');
    } catch {
      continue;
    }
    try {
      acc = parseDotenv(contents, acc);
    } catch (err) {
      throw new CooperError(`dotenv loading failed: error in file ${JSON.stringify(source)}: ${/** @type {Error} */ (err).message}`, {
        stage: 'dotenv',
        cause: err,
      });
    }
  }
  return acc;
}

module.exports = { env, parseDotenv, projectRoot };
