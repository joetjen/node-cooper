'use strict';

/**
 * @fileoverview Expands a parsed `for` statement (CASC.md §5.5) into the
 * entries it generates -- the port of `Cooper.Loop`.
 *
 * Expansion runs before merge and resolution, yet needs each element
 * binding's actual list to know how many iterations there are. So a
 * binding's iterable is resolved eagerly, against the variables the
 * current file can see *so far* -- never against something that only
 * exists after merge (a `%{...}` iterable is refused outright).
 *
 * Loop-bound variables are then bound lexically: every `@{name}` written
 * in the body (and in the destination path) that names a binding gets
 * that iteration's value attached (`VarRef#bound`), shadowing any outer
 * variable of the same name. The reference itself stays a reference, so
 * its own index, suffix, and filters still apply when it resolves -- the
 * reference implementation substitutes the bare value instead and loses
 * them (`@{port | upcase}` ignoring the filter).
 */

const CooperError = require('../error.cjs');
const Tuple = require('../values/tuple.cjs');
const { Block, VarRef, EnvRef, ConfigRef, TaggedRef, InterpText } = require('./nodes.cjs');

/** @typedef {import('./nodes.cjs').Entry} Entry */
/**
 * @typedef {{kind: 'index', name: string} | {kind: 'element', name: string, iterable: unknown}} Binding
 */

/**
 * @param {string} message
 * @returns {CooperError}
 */
const loopError = (message) => new CooperError(message, { stage: 'loop' });

/**
 * @param {Binding[]} bindings
 * @param {unknown[] | null} template -- `from <template>` path segments
 * @param {unknown[]} dest -- destination path segments
 * @param {boolean} destSecret
 * @param {Entry[]} body -- the loop body's already-evaluated entries
 * @param {(name: string) => {found: true, value: unknown} | {found: false}} lookupVar
 * @returns {Entry[]}
 */
function expandLoop(bindings, template, dest, destSecret, body, lookupVar) {
  const elements = /** @type {Array<Extract<Binding, {kind: 'element'}>>} */ (bindings.filter((b) => b.kind === 'element'));
  if (elements.length === 0) {
    throw loopError('a `for` loop needs at least one element binding (`@name in ...`) -- index-only is not allowed');
  }
  if (bindings.length - elements.length > 1) throw loopError('a `for` loop allows at most one index binding (`@name`)');

  const lists = elements.map((b) => ({ name: b.name, list: resolveIterable(b.iterable, lookupVar) }));
  const lengths = new Set(lists.map((l) => l.list.length));
  if (lengths.size > 1) {
    const detail = lists.map((l) => `@{${l.name}} (${l.list.length})`).join(', ');
    throw loopError(`for loop's bound lists have mismatched lengths: ${detail}`);
  }
  const count = lists[0].list.length;

  /** @type {Entry[]} */
  const out = [];
  for (let i = 0; i < count; i++) {
    /** @type {Map<string, unknown>} */
    const overlay = new Map(lists.map((l) => [l.name, l.list[i]]));
    for (const b of bindings) if (b.kind === 'index') overlay.set(b.name, i);

    const resolvedDest = dest.map((segment) => bind(segment, overlay));
    if (template !== null) {
      out.push({
        kind: 'op',
        path: resolvedDest,
        sigil: 'merge',
        value: new ConfigRef({ path: template.map((segment) => bind(segment, overlay)) }),
        secret: destSecret,
      });
    }
    for (const entry of body) {
      if (entry.kind === 'op') {
        out.push({
          ...entry,
          path: [...resolvedDest, ...entry.path.map((segment) => bind(segment, overlay))],
          value: bind(entry.value, overlay),
          secret: destSecret || entry.secret,
        });
      } else if (entry.kind === 'clear') {
        out.push({ ...entry, path: [...resolvedDest, ...entry.path.map((segment) => bind(segment, overlay))] });
      } else {
        out.push(entry);
      }
    }
  }
  return out;
}

/**
 * @param {unknown} iterable
 * @param {(name: string) => {found: true, value: unknown} | {found: false}} lookupVar
 * @returns {unknown[]}
 */
function resolveIterable(iterable, lookupVar) {
  if (Array.isArray(iterable)) return iterable;
  if (iterable instanceof VarRef) {
    if (typeof iterable.name !== 'string') throw loopError('a loop iterable must name its variable directly, not build the name');
    const found = lookupVar(iterable.name);
    if (!found.found) throw loopError(`loop iterable references undefined variable "@{${iterable.name}}"`);
    if (!Array.isArray(found.value)) throw loopError(`loop iterable "@{${iterable.name}}" is not a list`);
    return found.value;
  }
  if (iterable instanceof ConfigRef) {
    throw loopError(
      "a `%{...}` config reference can't be used as a loop iterable -- it only resolves after the full tree is merged, which happens after loop expansion"
    );
  }
  throw loopError('loop iterable must be a list literal or a variable reference to one');
}

/**
 * Attaches this iteration's binding values to every reference in `value`
 * that names one.
 * @param {unknown} value
 * @param {Map<string, unknown>} overlay
 * @returns {unknown}
 */
function bind(value, overlay) {
  if (value instanceof VarRef) {
    const parts = bindParts(value, overlay);
    if (typeof value.name === 'string') {
      const copy = new VarRef({ ...value, ...parts });
      copy.bound = value.bound ?? (overlay.has(value.name) ? { value: overlay.get(value.name) } : undefined);
      return copy;
    }
    const named = new VarRef({ ...value, ...parts, name: bind(value.name, overlay) });
    if (value.bound) named.bound = value.bound;
    return named;
  }
  if (value instanceof EnvRef) return new EnvRef({ ...value, ...bindParts(value, overlay), name: bind(value.name, overlay) });
  if (value instanceof ConfigRef) {
    return new ConfigRef({ ...value, ...bindParts(value, overlay), path: value.path.map((s) => bind(s, overlay)) });
  }
  if (value instanceof TaggedRef) return new TaggedRef(value.name, bind(value.arg, overlay));
  if (value instanceof InterpText) return new InterpText(value.segments.map((s) => bind(s, overlay)));
  // A block written as a list element (CASC.md §6.10) keeps its entries
  // until it is resolved, so the bindings reach its keys and values here.
  if (value instanceof Block) {
    return new Block(
      value.entries.map((entry) => {
        if (entry.kind === 'op') {
          return { ...entry, path: entry.path.map((segment) => bind(segment, overlay)), value: bind(entry.value, overlay) };
        }
        if (entry.kind === 'clear') return { ...entry, path: entry.path.map((segment) => bind(segment, overlay)) };
        return entry;
      })
    );
  }
  if (Array.isArray(value)) return value.map((item) => bind(item, overlay));
  if (value instanceof Tuple) return new Tuple(value.items.map((item) => bind(item, overlay)));
  return value;
}

/**
 * Whatever a reference carries besides its name that a binding can reach:
 * its suffix (`@{outer:@{loop_var}}`, `:?"no x=@{x}"`) and its filters'
 * arguments (`| trim_suffix: "@{x}"`). Only the suffix's default once
 * was, so a binding in a `:?` message or a filter argument survived the
 * loop and then failed as an undefined variable.
 * @param {{suffix: import('./nodes.cjs').Suffix | null, filters: import('./nodes.cjs').Filter[]}} ref
 * @param {Map<string, unknown>} overlay
 * @returns {{suffix: import('./nodes.cjs').Suffix | null, filters: import('./nodes.cjs').Filter[]}}
 */
function bindParts({ suffix, filters }, overlay) {
  /** @type {import('./nodes.cjs').Suffix | null} */
  let boundSuffix = suffix;
  if (suffix?.kind === 'required') boundSuffix = { kind: 'required', message: bind(suffix.message, overlay) };
  else if (suffix !== null) boundSuffix = { kind: suffix.kind, value: bind(suffix.value, overlay) };
  return { suffix: boundSuffix, filters: filters.map(({ name, arg }) => ({ name, arg: bind(arg, overlay) })) };
}

module.exports = { expandLoop };
