'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** Longest name `!module(...)` accepts, in UTF-8 bytes (same bound as the Elixir implementation). */
const MAX_BYTES = 512;

/**
 * A module name as CASC writes it (CASC.md §7.5): dot-separated
 * PascalCase segments, the same in every Cooper implementation. A Node
 * specifier (`./x.js`, `node:fs`, `@scope/pkg`) is not one: a document
 * names a module the same way for every host, and the application maps
 * the name to its Node module with the `modules` load option.
 */
const NAME = /^[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)*$/;

/**
 * The value of a `!module("Name")` tagged value (CASC.md §7.5) -- a
 * reference to a Node module, by the name the config wrote and the target
 * the application's `modules` load option maps that name to:
 *
 * ```text
 * client = !module("Acme.Payments.StripeClient")
 * formatter = !module("${LOG_FORMATTER}")
 * ```
 *
 * ```js
 * loadFileSync('config/app.casc', {
 *   modules: { 'Acme.Payments.StripeClient': './lib/payments/stripe.js' },
 * });
 * ```
 *
 * The reference implementation translates a name into an Elixir module
 * by convention. A Node module is a location, not a name, so there is no
 * convention to translate into here: every name comes from the mapping.
 *
 * Loading a config never imports anything. A mapping value that is a
 * specifier string is kept in `specifier` (a `./`/`../` one resolved to an
 * absolute path against `process.cwd()`, since the mapping is application
 * code, not part of the config file) and imported by `load()` when, and
 * if, the application asks. Any other mapping value -- an already-imported
 * module or a class -- is kept in `value` and handed back by `load()`.
 */
class ModuleRef {
  /**
   * @param {string} name -- the name as written in the config, trimmed
   * @param {unknown} target -- what the `modules` mapping holds for `name`: a specifier string, or the module itself
   * @param {string} [base] -- directory a relative specifier is resolved against (default `process.cwd()`)
   */
  constructor(name, target, base = process.cwd()) {
    const error = ModuleRef.validate(name);
    if (error !== null) throw new TypeError(error);
    /**
     * The name as written in the config (after trimming).
     * @type {string}
     */
    this.name = name;
    /**
     * What `load()` imports, when the mapping held a specifier: an absolute
     * path for a relative specifier, otherwise the specifier unchanged.
     * `undefined` when the mapping held the module itself.
     * @type {string | undefined}
     */
    this.specifier = typeof target === 'string' ? resolveSpecifier(target, base) : undefined;
    /**
     * The module the mapping held, when it was not a specifier string;
     * `undefined` otherwise.
     * @type {unknown}
     */
    this.value = typeof target === 'string' ? undefined : target;
    Object.freeze(this);
  }

  /**
   * Returns why `name` is not an acceptable module name, or `null` when
   * it is. `name` is taken as is: `!module` trims it first.
   * @param {unknown} name
   * @returns {string | null}
   */
  static validate(name) {
    if (typeof name !== 'string') return `cannot convert ${String(name)} to a module: not a string`;
    if (Buffer.byteLength(name, 'utf8') > MAX_BYTES) {
      return `cannot convert ${JSON.stringify(name)} to a module: longer than ${MAX_BYTES} bytes`;
    }
    if (!NAME.test(name)) {
      return `cannot convert ${JSON.stringify(name)} to a module: not a dot-separated PascalCase module name`;
    }
    return null;
  }

  /**
   * The module: a specifier is imported now (dynamic `import()`), a
   * provided value is handed back as is.
   * @returns {Promise<any>} the module namespace object, or the provided value
   */
  async load() {
    if (this.specifier === undefined) return this.value;
    const target = path.isAbsolute(this.specifier) ? pathToFileURL(this.specifier).href : this.specifier;
    return import(target);
  }

  /**
   * Equal when the name and the target are the same: the same resolved
   * specifier, or the very same provided value.
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof ModuleRef && other.name === this.name && other.specifier === this.specifier && other.value === this.value;
  }

  /** @returns {string} the name as written */
  toString() {
    return this.name;
  }

  /** @returns {string} */
  toJSON() {
    return this.name;
  }

  /** @returns {string} */
  [INSPECT]() {
    return `ModuleRef(${this.name})`;
  }
}

/**
 * A `./` or `../` specifier as an absolute path against `base`; any other
 * form (builtin, bare package, absolute path, `file:` URL) unchanged.
 * @param {string} specifier
 * @param {string} base
 * @returns {string}
 */
function resolveSpecifier(specifier, base) {
  return specifier.startsWith('./') || specifier.startsWith('../') ? path.resolve(base, specifier) : specifier;
}

module.exports = ModuleRef;
