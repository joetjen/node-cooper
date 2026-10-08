'use strict';

/**
 * @fileoverview The built-in tagged values (CASC.md §7.5): the converting
 * tags `!int`/`!float`/`!bool` (mainly for `${...}`, which always yields a
 * string), the constructors `!duration`/`!bytes`, the normalizing tags
 * `!trim`/`!downcase`/`!upcase`, and `!module` (which needs the
 * application's `modules` mapping). Each takes the resolved
 * argument and returns the value, or throws an `Error` whose message the
 * resolver reports as `!name(...) failed: <message>`.
 */

const Duration = require('../values/duration.cjs');
const ByteSize = require('../values/byte-size.cjs');
const ModuleRef = require('../values/module-ref.cjs');
const { CooperFloat } = require('../values/float.cjs');
const { normalizeInteger, parseDuration, parseBytes } = require('../grammar/literals.cjs');
const { describe } = require('./filters.cjs');

/** The strings `!bool` reads as true (CASC.md §7.5). */
const TRUE_SPELLINGS = new Set(['true', '1', 'yes', 'on']);
/** The strings `!bool` reads as false (CASC.md §7.5). */
const FALSE_SPELLINGS = new Set(['false', '0', 'no', 'off']);

/**
 * @param {(arg: string) => string} transform
 * @param {string} verb
 * @returns {(arg: unknown) => string}
 */
function stringTag(transform, verb) {
  return (arg) => {
    if (typeof arg !== 'string') throw new Error(`cannot ${verb} ${describe(arg)}: not a string`);
    return transform(arg);
  };
}

/**
 * The built-in tags for one load. `modules` is the application's mapping
 * from a `!module` name, exactly as written, to its Node module.
 * @param {Record<string, unknown> | Map<string, unknown>} [modules]
 * @returns {Record<string, (arg: unknown) => unknown>}
 */
function builtInTags(modules) {
  return {
    // A float is never an integer here, however whole: `!int(2.0)` is an
    // error, as in the reference. A `CooperFloat` (values/float.cjs) is
    // what lets this tell `2.0` from `2`.
    int(arg) {
      if (typeof arg === 'bigint' || (typeof arg === 'number' && Number.isInteger(arg))) return arg;
      if (typeof arg === 'string') {
        const text = arg.trim();
        if (/^[+-]?\d+$/.test(text)) return normalizeInteger(BigInt(text.replace(/^\+/, '')));
        throw new Error(`not an integer: ${JSON.stringify(arg)}`);
      }
      throw new Error(`cannot convert ${describe(arg)} to an integer`);
    },
    // Always a float, so `!float(7)` reads back as `7.0` in a string. It
    // once returned the plain number, which a later `"@{x}"` showed as `7`.
    float(arg) {
      if (arg instanceof CooperFloat) return arg;
      if (typeof arg === 'number') return new CooperFloat(arg);
      if (typeof arg === 'bigint') return new CooperFloat(Number(arg));
      if (typeof arg === 'string') {
        const text = arg.trim();
        if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return new CooperFloat(Number(text));
        throw new Error(`not a float: ${JSON.stringify(arg)}`);
      }
      throw new Error(`cannot convert ${describe(arg)} to a float`);
    },
    // The spellings a boolean arrives in from an environment (CASC.md
    // §7.5): `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off` -- lower case
    // only, as `true`/`false` always were. Only the first pair once was,
    // so the commonest `.env` spelling of all, `DEBUG=1`, failed the load.
    bool(arg) {
      if (typeof arg === 'boolean') return arg;
      if (typeof arg === 'string' && TRUE_SPELLINGS.has(arg)) return true;
      if (typeof arg === 'string' && FALSE_SPELLINGS.has(arg)) return false;
      throw new Error(`not a boolean: ${describe(arg)}`);
    },
    duration(arg) {
      if (arg instanceof Duration) return arg;
      if (typeof arg !== 'string') throw new Error(`cannot convert ${describe(arg)} to a duration`);
      const result = parseDuration(arg);
      if (typeof result === 'string') throw new Error(result);
      return new Duration(result);
    },
    bytes(arg) {
      if (arg instanceof ByteSize) return arg;
      if (typeof arg !== 'string') throw new Error(`cannot convert ${describe(arg)} to a byte size`);
      const result = parseBytes(arg);
      if (typeof result === 'string') throw new Error(result);
      return new ByteSize(result);
    },
    trim: stringTag((s) => s.trim(), 'trim'),
    downcase: stringTag((s) => s.toLowerCase(), 'downcase'),
    upcase: stringTag((s) => s.toUpperCase(), 'upcase'),
    // `!module("Name")` (CASC.md §7.5): the name must be dot-separated
    // PascalCase even when the mapping holds it, so one document names one
    // module in every implementation. Node has no naming convention to
    // translate a name into (a Node module is a location), so a name the
    // mapping does not hold is an error rather than a guess.
    module(arg) {
      const name = typeof arg === 'string' ? arg.trim() : arg;
      const error = ModuleRef.validate(name);
      if (error !== null) throw new Error(error);
      const written = /** @type {string} */ (name);
      const target = mapped(modules, written);
      if (target === undefined) {
        throw new Error(
          `cannot convert ${JSON.stringify(written)} to a module: the \`modules\` load option has no ${JSON.stringify(written)} (a Node module is a location, not a name, so every module name needs a mapping)`
        );
      }
      return new ModuleRef(written, target);
    },
  };
}

/**
 * What `modules` holds for `name`, by the name exactly as written; an
 * object's inherited properties never count.
 * @param {Record<string, unknown> | Map<string, unknown> | undefined} modules
 * @param {string} name
 * @returns {unknown}
 */
function mapped(modules, name) {
  if (modules instanceof Map) return modules.get(name);
  return modules && Object.hasOwn(modules, name) ? modules[name] : undefined;
}

module.exports = { builtInTags };
