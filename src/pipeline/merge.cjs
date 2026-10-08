'use strict';

/**
 * @fileoverview Folds the flat entry list into (almost) the final tree --
 * CASC.md §8 and §5.7, the port of `Cooper.Merge`. "Almost": leaves may
 * still be unresolved reference nodes, `Layered` values (a loop's lazy
 * `from` base with overrides on top), or `ListEdit`s (a `+`/`-` list edit
 * waiting on a reference); the resolver walks this next.
 *
 * Each op's sigil decides how it combines with what's already at its path:
 *
 * - `merge` (no sigil): set the leaf. Deep merge of blocks emerges for free
 *   from folding many leaf ops under the same parent.
 * - `replace` (`~key { ... }`): the evaluator emits one `clear` entry at the
 *   statement's path first, deleting the whole subtree; the leaves then
 *   land as ordinary sets.
 * - `append`/`remove` (`+key`/`-key = [...]`): list-only. A tuple there is
 *   a hard error (§8.3: a tuple is never merged, only replaced wholesale).
 * - `delete` (bare `-key.path`): remove the path, any type.
 *
 * Every path whose *final* writer was secret (`*key`) is wrapped in a
 * `Secret` here, before resolution, so the secrecy travels with the value
 * through any later `%{...}` copy rather than staying pinned to its path.
 */

const CooperError = require('../error.cjs');
const Tuple = require('../values/tuple.cjs');
const Secret = require('../values/secret.cjs');
const { isPlainObject, valueEquals } = require('../values/equality.cjs');
const { ABSENT, ConfigRef, Layered, ListEdit, isUnresolved } = require('./nodes.cjs');

/** @typedef {import('./nodes.cjs').Entry} Entry */
/** @typedef {Record<string, unknown>} Tree */

/**
 * Sets an own, enumerable property -- even for a key like `__proto__`,
 * which plain assignment would treat as the prototype.
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @param {unknown} value
 */
function put(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @returns {unknown}
 */
function own(object, key) {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/**
 * @param {string[]} path
 * @param {string} sigil
 * @returns {CooperError}
 */
function tupleGuardError(path, sigil) {
  return new CooperError(
    `"${sigil}${path.join('.')}" targets a tuple -- tuples are never merged, only replaced wholesale (CASC.md §8.3)`,
    { stage: 'merge' }
  );
}

/**
 * @param {string[]} path
 * @param {string} sigil
 * @returns {CooperError}
 */
function notAListError(path, sigil) {
  return new CooperError(`"${sigil}${path.join('.')}" needs a list at that path, found something else`, { stage: 'merge' });
}

/**
 * Whether `value` (or anything inside a list, tuple, or map of it) is
 * unresolved. An element block (CASC.md §6.10) is, so a `-key` naming
 * one waits until it is a map that can be compared.
 * @param {unknown} value
 * @returns {boolean}
 */
function containsUnresolved(value) {
  if (isUnresolved(value)) return true;
  if (Array.isArray(value)) return value.some(containsUnresolved);
  if (value instanceof Tuple) return value.items.some(containsUnresolved);
  if (isPlainObject(value)) return Object.values(value).some(containsUnresolved);
  return false;
}

/**
 * @param {Tree} tree
 * @param {string[]} path
 * @returns {{found: true, value: unknown} | {found: false}}
 */
function getAt(tree, path) {
  /** @type {unknown} */
  let node = tree;
  for (const segment of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return { found: false };
    node = node[segment];
  }
  return { found: true, value: node };
}

/**
 * Where `path` runs into a lazy `for ... from` base before reaching its
 * end: the `%{...}` that will supply its value once the template resolves
 * (an override already written at that path wins). `null` when the path
 * never touches a lazy base.
 * @param {unknown} tree
 * @param {string[]} path
 * @returns {{found: true, value: unknown} | {lazy: ConfigRef} | null}
 */
function lazyAt(tree, path) {
  /** @type {unknown} */
  let node = tree;
  for (let i = 0; i < path.length; i++) {
    const rest = path.slice(i);
    if (node instanceof ConfigRef) return { lazy: new ConfigRef({ path: [...node.path, ...rest], suffix: { kind: 'default', value: ABSENT } }) };
    if (node instanceof Layered) {
      const override = getAt(node.overrides, rest);
      if (override.found) return override;
      return { lazy: new ConfigRef({ path: [...node.base.path, ...rest], suffix: { kind: 'default', value: ABSENT } }) };
    }
    if (!isPlainObject(node) || !Object.hasOwn(node, path[i])) return null;
    node = node[path[i]];
  }
  return null;
}

/**
 * Returns `tree` with `value` at `path`, sharing everything else. An
 * intermediate value that isn't a map is replaced by one -- except a lazy
 * `%{...}` base (a loop's `from` template), which is wrapped in a
 * `Layered` so the resolver can still apply the base first.
 * @param {unknown} tree
 * @param {string[]} path
 * @param {unknown} value
 * @returns {Tree | Layered}
 */
function putAt(tree, path, value) {
  // Writing into `{}`/a plain map always yields a plain map.
  if (tree instanceof ConfigRef) return new Layered(tree, /** @type {Tree} */ (putAt({}, path, value)));
  if (tree instanceof Layered) return new Layered(tree.base, /** @type {Tree} */ (putAt(tree.overrides, path, value)));
  const base = isPlainObject(tree) ? tree : {};
  /** @type {Tree} */
  const copy = {};
  for (const key of Object.keys(base)) put(copy, key, base[key]);
  const [head, ...rest] = path;
  put(copy, head, rest.length === 0 ? value : putAt(own(base, head), rest, value));
  return copy;
}

/**
 * @param {unknown} tree
 * @param {string[]} path
 * @returns {unknown}
 */
function deleteAt(tree, path) {
  if (path.length === 0) return {};
  if (!isPlainObject(tree) || !Object.hasOwn(tree, path[0])) return tree;
  /** @type {Tree} */
  const copy = {};
  for (const key of Object.keys(tree)) put(copy, key, tree[key]);
  if (path.length === 1) delete copy[path[0]];
  else put(copy, path[0], deleteAt(tree[path[0]], path.slice(1)));
  return copy;
}

/**
 * Folds entries into a tree. Every op path must already be plain strings
 * (interpolated keys are resolved before this runs).
 * @param {Entry[]} entries
 * @returns {Tree}
 */
function assemble(entries) {
  /** @type {Tree} */
  let tree = {};
  /** @type {Map<string, string[]>} secret paths, keyed by their JSON form */
  const secrets = new Map();
  /** @param {string[]} path @param {boolean} secret */
  const track = (path, secret) => {
    if (secret) secrets.set(JSON.stringify(path), path);
    else secrets.delete(JSON.stringify(path));
  };

  for (const entry of entries) {
    if (entry.kind === 'var') continue;
    const path = /** @type {string[]} */ (entry.path);

    if (entry.kind === 'clear') {
      const existing = getAt(tree, path);
      if (existing.found && existing.value instanceof Tuple) throw tupleGuardError(path, '~');
      tree = /** @type {Tree} */ (deleteAt(tree, path));
      continue;
    }

    // An empty block (`w {}`, CASC.md §5.4) is an empty map, and blocks
    // deep-merge: written over a map already there it adds nothing, so
    // the map stays as it is. Only where there is none -- or something
    // that is not a map -- does it become `{}`.
    if (entry.sigil === 'merge' && isPlainObject(entry.value) && Object.keys(entry.value).length === 0) {
      const existing = getAt(tree, path);
      if (!existing.found || !isPlainObject(existing.value)) tree = /** @type {Tree} */ (putAt(tree, path, {}));
      track(path, entry.secret);
      continue;
    }

    switch (entry.sigil) {
      case 'merge':
      case 'replace':
        tree = /** @type {Tree} */ (putAt(tree, path, entry.value));
        track(path, entry.secret);
        break;

      case 'append':
      case 'remove': {
        const sigil = entry.sigil === 'append' ? '+' : '-';
        const lazy = lazyAt(tree, path);
        if (lazy !== null && 'lazy' in lazy) {
          // The list comes from a `for ... from` template: edit it once the
          // template resolves.
          tree = /** @type {Tree} */ (putAt(tree, path, new ListEdit(lazy.lazy, entry.sigil, entry.value, path)));
          track(path, entry.secret);
          break;
        }
        const existing = lazy ?? getAt(tree, path);
        if (existing.found && existing.value instanceof Tuple) throw tupleGuardError(path, sigil);
        if (!existing.found) {
          // `+key` on a missing key is a plain assignment; `-key` a no-op.
          if (entry.sigil === 'append') {
            tree = /** @type {Tree} */ (putAt(tree, path, entry.value));
            track(path, entry.secret);
          }
          break;
        }
        const base = existing.value;
        const deferred =
          (isUnresolved(base) && !Array.isArray(base)) ||
          isUnresolved(entry.value) ||
          (entry.sigil === 'remove' && (containsUnresolved(base) || containsUnresolved(entry.value)));
        let next;
        if (deferred) {
          next = new ListEdit(base, entry.sigil, entry.value, path);
        } else if (!Array.isArray(base)) {
          throw notAListError(path, sigil);
        } else {
          const operand = Array.isArray(entry.value) ? entry.value : [entry.value];
          next = entry.sigil === 'append' ? [...base, ...operand] : base.filter((item) => !operand.some((o) => valueEquals(item, o)));
        }
        tree = /** @type {Tree} */ (putAt(tree, path, next));
        track(path, entry.secret);
        break;
      }

      case 'delete': {
        const lazy = lazyAt(tree, path);
        // Under a `for ... from` base the key may come from the template,
        // so record its absence rather than deleting nothing.
        tree = /** @type {Tree} */ (lazy !== null ? putAt(tree, path, ABSENT) : deleteAt(tree, path));
        const prefix = JSON.stringify(path).slice(0, -1);
        for (const [key, secretPath] of secrets) {
          if (secretPath.length >= path.length && (key === JSON.stringify(path) || key.startsWith(`${prefix},`))) secrets.delete(key);
        }
        break;
      }
    }
  }

  return /** @type {Tree} */ (wrapSecrets(tree, new Set(secrets.keys()), []));
}

/**
 * Wraps every secret path's value -- whole, whatever its shape -- in a
 * `Secret`. Only descends plain maps: a secret path is always a chain of
 * map keys.
 * @param {unknown} value
 * @param {Set<string>} secrets
 * @param {string[]} path
 * @returns {unknown}
 */
function wrapSecrets(value, secrets, path) {
  if (secrets.size === 0) return value;
  if (path.length > 0 && secrets.has(JSON.stringify(path))) return new Secret(value);
  if (!isPlainObject(value)) return value;
  /** @type {Tree} */
  const out = {};
  for (const key of Object.keys(value)) put(out, key, wrapSecrets(value[key], secrets, [...path, key]));
  return out;
}

module.exports = { assemble, put };
