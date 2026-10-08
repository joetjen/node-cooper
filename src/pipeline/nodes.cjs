'use strict';

/**
 * @fileoverview The unresolved intermediate representation every pipeline
 * stage between parsing and resolution passes along -- the port of
 * `Cooper.Op`, `Cooper.VarDecl`, `Cooper.Interp.Text`, `Cooper.Ref.*`, and
 * `Cooper.Merge.Layered`. None of these ever reach a caller of
 * `loadFile`/`loadString`; resolution replaces every one of them.
 *
 * Each is a class rather than a tagged object for the same reason the
 * Elixir side uses structs: a CASC value is arbitrary user data, so a
 * marker that can't collide with one is worth having.
 */

/**
 * `:default`, `:+alt`, `:?"message"` (CASC.md §7.2), shared by all three
 * reference forms. A message is a string, or an `InterpText` when it
 * interpolates.
 * @typedef {{kind: 'default', value: unknown} | {kind: 'substitute', value: unknown} | {kind: 'required', message: unknown}} Suffix
 */

/**
 * One `| name` or `| name: "arg"` filter (CASC.md §7.2). A double-quoted
 * argument that interpolates is an `InterpText` until resolution.
 * @typedef {{name: string, arg: unknown}} Filter
 */

/** An unresolved `@{name}` (CASC.md §7.1). */
class VarRef {
  /**
   * @param {{name: unknown, index?: number | null, suffix?: Suffix | null, filters?: Filter[], scope?: string | null}} fields
   */
  constructor({ name, index = null, suffix = null, filters = [], scope = null }) {
    /** The name, or an interpolated value that builds it (CASC.md §7.2 "Built names"). */
    this.name = name;
    /** @type {number | null} */
    this.index = index;
    /** @type {Suffix | null} */
    this.suffix = suffix;
    /** @type {Filter[]} */
    this.filters = filters;
    /**
     * The file this reference was written in -- decides whether it may see
     * a private `@*name` (CASC.md §5.2). Set when the reference is built.
     * @type {string | null}
     */
    this.scope = scope;
    /**
     * A `for` loop binding's value for one iteration, attached by
     * `loop.cjs` -- when set, the reference resolves to this instead of
     * looking its name up (CASC.md §5.5's body-scoped loop variables).
     * @type {{value: unknown} | undefined}
     */
    this.bound = undefined;
  }
}

/** An unresolved `${NAME}` (CASC.md §7.2) -- always a string unless tagged. */
class EnvRef {
  /**
   * @param {{name: unknown, index?: number | null, list?: boolean, suffix?: Suffix | null, filters?: Filter[]}} fields
   */
  constructor({ name, index = null, list = false, suffix = null, filters = [] }) {
    this.name = name;
    /** @type {number | null} */
    this.index = index;
    /** `${NAME[]}` -- split into a list. */
    this.list = list;
    /** @type {Suffix | null} */
    this.suffix = suffix;
    /** @type {Filter[]} */
    this.filters = filters;
  }
}

/** An unresolved `%{path}` (CASC.md §7.3) -- lazy, against the final tree. */
class ConfigRef {
  /**
   * @param {{path: unknown[], index?: number | null, suffix?: Suffix | null, filters?: Filter[]}} fields
   */
  constructor({ path, index = null, suffix = null, filters = [] }) {
    /** Key segments; a segment may be an interpolated value that builds it. */
    this.path = path;
    /** @type {number | null} */
    this.index = index;
    /** @type {Suffix | null} */
    this.suffix = suffix;
    /** @type {Filter[]} */
    this.filters = filters;
  }
}

/** An unresolved `!{name:payload}` (CASC.md §7.4). */
class ResolverRef {
  /**
   * @param {string} name
   * @param {string} payload -- verbatim, never parsed further
   */
  constructor(name, payload) {
    this.name = name;
    this.payload = payload;
  }
}

/** An unresolved `!Name(arg)` (CASC.md §7.5). */
class TaggedRef {
  /**
   * @param {string} name
   * @param {unknown} arg -- an ordinary value, itself possibly unresolved
   */
  constructor(name, arg) {
    this.name = name;
    this.arg = arg;
  }
}

/**
 * A double-quoted string that interpolates at least one reference --
 * literal runs and reference nodes, in order. A string with no reference
 * at all stays a plain `string`.
 */
class InterpText {
  /** @param {unknown[]} segments */
  constructor(segments) {
    this.segments = segments;
  }
}

/**
 * A path whose value is a lazy base (a `for` loop's `from <template>`,
 * CASC.md §5.5) with literal statements layered on top as overrides.
 */
class Layered {
  /**
   * @param {ConfigRef} base
   * @param {Record<string, unknown>} overrides
   */
  constructor(base, overrides) {
    this.base = base;
    this.overrides = overrides;
  }
}

/**
 * A `+key`/`-key` list edit (CASC.md §8.4) whose base or operand is not
 * known until resolution -- `+hosts = ${EXTRA_HOSTS[]}`, or an append to
 * a list that is itself a reference. Applied once both sides resolve.
 */
class ListEdit {
  /**
   * @param {unknown} base
   * @param {'append' | 'remove'} op
   * @param {unknown} operand
   * @param {string[]} path -- for error messages
   */
  constructor(base, op, operand, path) {
    this.base = base;
    this.op = op;
    this.operand = operand;
    this.path = path;
  }
}

/**
 * A block written as a list or tuple element (`[{ path = "^/admin" }]`,
 * CASC.md §6.10) -- the port of `Cooper.Block` as an element. It keeps
 * its flattened entries until resolution, where its keys (which may
 * interpolate, and so may need the tree) are resolved and its entries
 * merged into a map the way a document's are. Merging it any earlier
 * would have to resolve those keys before the variables and loop
 * bindings they name are settled.
 */
class Block {
  /** @param {Entry[]} entries */
  constructor(entries) {
    /** @type {Entry[]} */
    this.entries = entries;
  }
}

/**
 * Marks a key removed from what a lazy `for ... from` template supplies
 * (`-key` in the loop body, or a `+`/`-` edit of a key the template turns
 * out not to have). Only ever appears inside a `Layered`'s overrides;
 * resolving the `Layered` drops the key.
 */
class Absent {}
/** @type {Readonly<object>} */
const ABSENT = Object.freeze(new Absent());

/**
 * One flattened leaf assignment. Every statement form -- dotted path,
 * nested block, `= { ... }` -- flattens into these before merge, so merge
 * only ever deals in paths.
 *
 * @typedef {'merge' | 'replace' | 'append' | 'remove' | 'delete'} Sigil
 * @typedef {{kind: 'op', path: unknown[], sigil: Sigil, value: unknown, secret: boolean}} OpEntry
 * @typedef {{kind: 'var', name: string, value: unknown, public: boolean}} VarEntry
 * @typedef {{kind: 'clear', path: unknown[]}} ClearEntry
 * @typedef {OpEntry | VarEntry | ClearEntry} Entry
 */

/**
 * Whether `value` is one of the unresolved node classes above.
 * @param {unknown} value
 * @returns {boolean}
 */
function isUnresolved(value) {
  return (
    value instanceof VarRef ||
    value instanceof EnvRef ||
    value instanceof ConfigRef ||
    value instanceof ResolverRef ||
    value instanceof TaggedRef ||
    value instanceof InterpText ||
    value instanceof Layered ||
    value instanceof ListEdit ||
    value instanceof Block
  );
}

module.exports = { ABSENT, Block, VarRef, EnvRef, ConfigRef, ResolverRef, TaggedRef, InterpText, Layered, ListEdit, isUnresolved };
