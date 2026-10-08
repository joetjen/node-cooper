'use strict';

/**
 * @fileoverview Resolves everything merge left unresolved -- the port of
 * `Cooper.Resolver`:
 *
 * - `@{...}` against the variable environment (a reference sees its own
 *   file's private `@*name` declarations first, then the shared public
 *   ones -- CASC.md §5.2), cycle-checked;
 * - `${...}` against the environment, always a string unless tagged;
 * - `%{...}` lazily against the *final* merged tree, memoized and
 *   cycle-checked (CASC.md §7.3);
 * - `!{resolver:payload}` and `!Name(arg)` by dispatch to the registered
 *   functions (CASC.md §9.1/§9.2), each call an effect (`effects.cjs`) so
 *   it may be asynchronous;
 * - `Layered` loop bases and deferred `ListEdit`s;
 * - and `Secret`s, by resolving the wrapped value and re-wrapping it, so
 *   secrecy travels with a value wherever a reference copies it.
 *
 * The same machinery resolves interpolated *keys* before merge (see
 * `resolveKey`), where no tree exists yet and a `%{...}` is an error.
 */

const CooperError = require('../error.cjs');
const Tuple = require('../values/tuple.cjs');
const Secret = require('../values/secret.cjs');
const { isPlainObject, valueEquals } = require('../values/equality.cjs');
const { ABSENT, Block, VarRef, EnvRef, ConfigRef, ResolverRef, TaggedRef, InterpText, Layered, ListEdit } = require('./nodes.cjs');
const { call } = require('./effects.cjs');
const { display } = require('./display.cjs');
const { applyFilters, describe } = require('./filters.cjs');
const { builtInTags } = require('./tags.cjs');
const { assemble, put } = require('./merge.cjs');

/** @template T @typedef {import('./effects.cjs').Pipeline<T>} Pipeline */
/** @typedef {{ok: true, value: unknown} | {ok: false}} Fetch */

/** What a built `${...}`/`@{...}` name must resolve to (CASC.md §7.2). */
const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @type {Fetch} */
const MISSING = { ok: false };

/**
 * @param {string} message
 * @returns {CooperError}
 */
const resolveError = (message) => new CooperError(message, { stage: 'resolve' });

/**
 * @param {Record<string, unknown> | Map<string, unknown> | undefined} registry
 * @param {string} name
 * @returns {unknown}
 */
function lookup(registry, name) {
  if (registry instanceof Map) return registry.get(name);
  return registry && Object.hasOwn(registry, name) ? registry[name] : undefined;
}

/**
 * @typedef {object} ResolverOptions
 * @property {Record<string, unknown> | null} tree -- `null` while resolving keys, before a tree exists
 * @property {Map<string, unknown>} publicVars
 * @property {Map<string, Map<string, unknown>>} privateByScope
 * @property {Record<string, string>} env
 * @property {Record<string, Function> | Map<string, Function>} [resolvers]
 * @property {Record<string, Function> | Map<string, Function>} [tags]
 * @property {Record<string, unknown> | Map<string, unknown>} [modules] -- what each `!module("Name")` means
 */

class Resolver {
  /** @param {ResolverOptions} opts */
  constructor(opts) {
    this.tree = opts.tree;
    this.publicVars = opts.publicVars;
    this.privateByScope = opts.privateByScope;
    this.env = opts.env;
    this.resolvers = opts.resolvers;
    this.userTags = opts.tags;
    this.builtIns = builtInTags(opts.modules);
    /** @type {Map<string, unknown>} `%{...}` results, by path */
    this.pathCache = new Map();
    /** @type {string[][]} `%{...}` paths being resolved, outermost first */
    this.inProgress = [];
    /** @type {Array<{key: string, name: string}>} `@{...}` bindings being resolved */
    this.varInProgress = [];
    /** @type {Map<object, unknown>} each `!{...}`/`!Name(...)` occurrence is resolved (and called) once */
    this.dispatchCache = new Map();
    /** @type {Set<string>} every `${NAME}` looked up, found or not */
    this.envNames = new Set();
  }

  /**
   * @param {unknown} value
   * @returns {Pipeline<unknown>}
   */
  *resolve(value) {
    if (value instanceof VarRef) return yield* this.resolveVar(value);
    if (value instanceof EnvRef) return yield* this.resolveEnv(value);
    if (value instanceof ConfigRef) return yield* this.resolveConfig(value);
    if (value instanceof ResolverRef) return yield* this.dispatchOnce(value, () => this.resolveResolver(value));
    if (value instanceof TaggedRef) return yield* this.dispatchOnce(value, () => this.resolveTagged(value));
    if (value instanceof InterpText) return yield* this.resolveText(value.segments);
    if (value instanceof Layered) return yield* this.resolveLayered(value);
    if (value instanceof ListEdit) return yield* this.resolveListEdit(value);
    if (value instanceof Block) return yield* this.resolveBlock(value);
    if (value instanceof Secret) {
      // Resolve the wrapped value and re-wrap. A secret inside a secret
      // collapses: the outer `*` means "redact this whole thing".
      const inner = yield* this.resolve(value.value);
      return new Secret(inner instanceof Secret ? inner.value : inner);
    }
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) out.push(yield* this.resolve(item));
      return out;
    }
    if (value instanceof Tuple) {
      const out = [];
      for (const item of value.items) out.push(yield* this.resolve(item));
      return new Tuple(out);
    }
    if (isPlainObject(value)) {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const key of Object.keys(value)) put(out, key, yield* this.resolve(value[key]));
      return out;
    }
    return value;
  }

  /**
   * @param {object} node
   * @param {() => Pipeline<unknown>} run
   * @returns {Pipeline<unknown>}
   */
  *dispatchOnce(node, run) {
    if (this.dispatchCache.has(node)) return this.dispatchCache.get(node);
    const value = yield* run();
    this.dispatchCache.set(node, value);
    return value;
  }

  // ---- @{...} -------------------------------------------------------------

  /**
   * @param {InstanceType<typeof import('./nodes.cjs').VarRef>} ref
   * @returns {Pipeline<unknown>}
   */
  *resolveVar(ref) {
    const name = typeof ref.name === 'string' ? ref.name : yield* this.resolveRefName(ref.name, '@{...}');
    const label = `@{${name}}`;
    if (ref.bound) {
      const value = yield* this.resolve(ref.bound.value);
      return yield* this.finish(applyIndex(value, ref.index), ref, label);
    }
    const privates = ref.scope === null ? undefined : this.privateByScope.get(ref.scope);
    const isPrivate = privates !== undefined && privates.has(name);
    if (!isPrivate && !this.publicVars.has(name)) return yield* this.finish(MISSING, ref, label);

    const key = `${isPrivate ? ref.scope : ''}\u0000${name}`;
    if (this.varInProgress.some((b) => b.key === key)) {
      const chain = [...this.varInProgress.map((b) => b.name), name].join(' -> ');
      throw resolveError(`circular @{...} reference: ${chain}`);
    }
    const raw = isPrivate ? /** @type {Map<string, unknown>} */ (privates).get(name) : this.publicVars.get(name);
    this.varInProgress.push({ key, name });
    const value = yield* this.resolve(raw);
    this.varInProgress.pop();
    return yield* this.finish(applyIndex(value, ref.index), ref, label);
  }

  /**
   * A reference name built by interpolation (CASC.md §7.2): it must
   * resolve to an identifier, and never to a secret -- names appear in
   * error messages, which don't redact.
   * @param {unknown} nameValue
   * @param {string} label
   * @returns {Pipeline<string>}
   */
  *resolveRefName(nameValue, label) {
    const name = yield* this.resolve(nameValue);
    if (name instanceof Secret) throw resolveError(`${label} name may not be built from a secret value`);
    if (typeof name !== 'string') throw resolveError(`${label} name must resolve to a string, got: ${describe(name)}`);
    if (!REF_NAME.test(name)) throw resolveError(`${label} resolved to ${JSON.stringify(name)}, which is not a valid name`);
    return name;
  }

  // ---- ${...} -------------------------------------------------------------

  /**
   * @param {InstanceType<typeof import('./nodes.cjs').EnvRef>} ref
   * @returns {Pipeline<unknown>}
   */
  *resolveEnv(ref) {
    const name = typeof ref.name === 'string' ? ref.name : yield* this.resolveRefName(ref.name, '${...}');
    this.envNames.add(name);
    const raw = Object.hasOwn(this.env, name) ? this.env[name] : undefined;
    /** @type {Fetch} */
    let fetch = MISSING;
    if (raw !== undefined && raw !== '') {
      if (ref.list) fetch = { ok: true, value: splitEnvList(raw) };
      else if (ref.index !== null) fetch = applyIndex(splitEnvList(raw), ref.index);
      else fetch = { ok: true, value: raw };
    }
    return yield* this.finish(fetch, ref, `\${${name}}`);
  }

  // ---- %{...} -------------------------------------------------------------

  /**
   * @param {InstanceType<typeof import('./nodes.cjs').ConfigRef>} ref
   * @returns {Pipeline<unknown>}
   */
  *resolveConfig(ref) {
    /** @type {string[]} */
    const path = [];
    for (const segment of ref.path) path.push(typeof segment === 'string' ? segment : yield* this.resolveKeySegment(segment));
    const label = `%{${path.join('.')}}`;
    if (this.tree === null) {
      throw resolveError(`${label} cannot be used in a key -- keys are resolved before the tree they would refer to exists`);
    }
    const fetch = yield* this.resolvePath(path);
    return yield* this.finish(fetch.ok ? applyIndex(fetch.value, ref.index) : MISSING, ref, label);
  }

  /**
   * A `%{...}` key segment built by interpolation: unlike a name, any
   * string will do, except an empty one (wrong depth), a dotted one (it
   * would silently become two segments), or a secret.
   * @param {unknown} segment
   * @returns {Pipeline<string>}
   */
  *resolveKeySegment(segment) {
    const key = yield* this.resolve(segment);
    if (key instanceof Secret) throw resolveError('%{...} key may not be built from a secret value');
    if (typeof key !== 'string') throw resolveError(`%{...} key must resolve to a string, got: ${describe(key)}`);
    if (key === '') throw resolveError('%{...} key resolved to an empty string');
    if (key.includes('.')) {
      throw resolveError(`%{...} key resolved to ${JSON.stringify(key)}, which would split into more than one path segment`);
    }
    return key;
  }

  /**
   * The resolved value at `path` in the final tree, memoized; a path
   * reached again while still being resolved is a cycle.
   * @param {string[]} path
   * @returns {Pipeline<Fetch>}
   */
  *resolvePath(path) {
    const key = JSON.stringify(path);
    if (this.pathCache.has(key)) return { ok: true, value: this.pathCache.get(key) };
    if (this.inProgress.some((p) => JSON.stringify(p) === key)) {
      const chain = [...this.inProgress, path].map((p) => p.join('.')).join(' -> ');
      throw resolveError(`circular %{...} reference: ${chain}`);
    }
    const raw = yield* this.fetchTreePath(/** @type {Record<string, unknown>} */ (this.tree), path);
    if (!raw.ok) return MISSING;
    this.inProgress.push(path);
    const value = yield* this.resolve(raw.value);
    this.inProgress.pop();
    this.pathCache.set(key, value);
    return { ok: true, value };
  }

  /**
   * Walks the unresolved tree, resolving a `Layered` loop base (or a
   * secret-wrapped map) on the way through so a path can continue into it.
   * @param {unknown} node
   * @param {string[]} path
   * @returns {Pipeline<Fetch>}
   */
  *fetchTreePath(node, path) {
    if (path.length === 0) return { ok: true, value: node };
    if (node instanceof Layered) return yield* this.fetchTreePath(yield* this.resolveLayered(node), path);
    if (node instanceof Secret) {
      const inner = yield* this.fetchTreePath(yield* this.resolve(node.value), path);
      return inner.ok ? { ok: true, value: new Secret(Secret.reveal(inner.value)) } : inner;
    }
    if (!isPlainObject(node) || !Object.hasOwn(node, path[0])) return MISSING;
    return yield* this.fetchTreePath(node[path[0]], path.slice(1));
  }

  // ---- interpolated keys and element blocks ---------------------------------

  /**
   * An interpolated key segment (CASC.md §4.2): a non-empty string with no
   * `.` in it, never built from a secret. An empty one would address the
   * wrong depth, and a dotted one would silently be read as two segments;
   * both were once accepted. Loop-built keys reach here too (their
   * bindings are attached to the references), so the rule is the same
   * inside a `for` loop as outside one -- and inside an element block.
   * @param {unknown} segment
   * @returns {Pipeline<string>}
   */
  *resolveKey(segment) {
    const key = yield* this.resolve(segment);
    if (key instanceof Secret) throw resolveError('a key may not be built from a secret value');
    if (typeof key !== 'string') throw resolveError('a key must resolve to a string');
    if (key === '') throw resolveError('interpolated key resolved to an empty string');
    if (key.includes('.')) {
      throw resolveError(`interpolated key resolved to ${JSON.stringify(key)}, which would split into more than one path segment`);
    }
    return key;
  }

  /**
   * A block written as a list or tuple element (`[{ path = "^/admin" }]`,
   * CASC.md §6.10): its keys are resolved -- they may interpolate, which
   * is why it waited until now -- its entries merged into a map the way a
   * document's are, and that map resolved like any other. While keys are
   * being resolved there is no tree yet, and a key is a string, so one
   * here is refused, as the reference refuses it.
   * @param {InstanceType<typeof import('./nodes.cjs').Block>} block
   * @returns {Pipeline<unknown>}
   */
  *resolveBlock(block) {
    if (this.tree === null) {
      throw resolveError(
        'an interpolated key may only reference @{...} and ${...} -- it is resolved before the tree, resolvers, and tags it would need'
      );
    }
    /** @type {import('./nodes.cjs').Entry[]} */
    const entries = [];
    for (const entry of block.entries) {
      if (entry.kind === 'var') {
        entries.push(entry);
        continue;
      }
      const keyPath = [];
      for (const segment of entry.path) keyPath.push(typeof segment === 'string' ? segment : yield* this.resolveKey(segment));
      entries.push({ ...entry, path: keyPath });
    }
    return yield* this.resolve(assemble(entries));
  }

  // ---- Layered / ListEdit ---------------------------------------------------

  /**
   * @param {InstanceType<typeof import('./nodes.cjs').Layered>} layered
   * @returns {Pipeline<unknown>}
   */
  *resolveLayered(layered) {
    const base = yield* this.resolve(layered.base);
    const overrides = yield* this.resolve(layered.overrides);
    return deepMerge(base, overrides);
  }

  /**
   * @param {InstanceType<typeof import('./nodes.cjs').ListEdit>} edit
   * @returns {Pipeline<unknown>}
   */
  *resolveListEdit(edit) {
    const sigil = edit.op === 'append' ? '+' : '-';
    let base = yield* this.resolve(edit.base);
    if (base === ABSENT) {
      // A template without this key: `+key` is a plain assignment, `-key`
      // leaves it absent.
      return edit.op === 'append' ? yield* this.resolve(edit.operand) : ABSENT;
    }
    let secret = false;
    if (base instanceof Secret) {
      secret = true;
      base = base.value;
    }
    if (base instanceof Tuple) {
      throw resolveError(`"${sigil}${edit.path.join('.')}" targets a tuple -- tuples are never merged, only replaced wholesale (CASC.md §8.3)`);
    }
    if (!Array.isArray(base)) throw resolveError(`"${sigil}${edit.path.join('.')}" needs a list at that path, found ${describe(base)}`);
    let operand = yield* this.resolve(edit.operand);
    if (operand instanceof Secret) {
      secret = true;
      operand = operand.value;
    }
    const items = Array.isArray(operand) ? operand : [operand];
    const result = edit.op === 'append' ? [...base, ...items] : base.filter((item) => !items.some((o) => valueEquals(item, o)));
    return secret ? new Secret(result) : result;
  }

  // ---- !{resolver:payload} / !Name(arg) -------------------------------------

  /**
   * @param {InstanceType<typeof import('./nodes.cjs').ResolverRef>} ref
   * @returns {Pipeline<unknown>}
   */
  *resolveResolver(ref) {
    const fn = lookup(/** @type {any} */ (this.resolvers), ref.name);
    if (typeof fn !== 'function') throw resolveError(`unregistered resolver ${JSON.stringify(ref.name)}`);
    try {
      return yield* call(/** @type {any} */ (fn), ref.payload, `resolver "${ref.name}"`, 'resolve');
    } catch (err) {
      if (err instanceof CooperError) throw err;
      throw new CooperError(
        `resolver ${JSON.stringify(ref.name)} failed for payload ${JSON.stringify(ref.payload)}: ${err instanceof Error ? err.message : String(err)}`,
        { stage: 'resolve', cause: err }
      );
    }
  }

  /**
   * A secret-sourced argument is unwrapped for the tag function and the
   * result re-wrapped: a value derived from a secret is still a secret.
   * @param {InstanceType<typeof import('./nodes.cjs').TaggedRef>} ref
   * @returns {Pipeline<unknown>}
   */
  *resolveTagged(ref) {
    const arg = yield* this.resolve(ref.arg);
    const user = lookup(/** @type {any} */ (this.userTags), ref.name);
    const fn = typeof user === 'function' ? user : Object.hasOwn(this.builtIns, ref.name) ? this.builtIns[ref.name] : undefined;
    if (typeof fn !== 'function') throw resolveError(`unregistered tag !${ref.name}(...)`);
    const secret = arg instanceof Secret;
    const plain = secret ? arg.value : arg;
    let value;
    try {
      // Every tag, a consumer's included, is handed floats as
      // `CooperFloat`s, so it can tell `2.0` from `2` as the reference's
      // tags can. They were once unwrapped to plain numbers for a
      // consumer's tag, which then doubled `!twice(2.0)` to `4`.
      value = yield* call(/** @type {any} */ (fn), plain, `tag !${ref.name}(...)`, 'resolve');
    } catch (err) {
      if (err instanceof CooperError) throw err;
      throw new CooperError(`!${ref.name}(...) failed: ${err instanceof Error ? err.message : String(err)}`, { stage: 'resolve', cause: err });
    }
    return secret ? new Secret(value) : value;
  }

  // ---- interpolated strings -------------------------------------------------

  /**
   * Joins resolved segments. A segment that resolved to a secret makes the
   * whole string a `Secret` whose display text redacts only that segment.
   * @param {unknown[]} segments
   * @returns {Pipeline<unknown>}
   */
  *resolveText(segments) {
    let real = '';
    let shown = '';
    let secretSeen = false;
    for (const segment of segments) {
      const value = yield* this.resolve(segment);
      if (value instanceof Secret) {
        secretSeen = true;
        real += display(value.value);
        shown += value.redacted ?? Secret.REDACTED;
      } else {
        const text = display(value);
        real += text;
        shown += text;
      }
    }
    return secretSeen ? new Secret(real, shown) : real;
  }

  // ---- suffix and filters ---------------------------------------------------

  /**
   * Settles a reference's value from its lookup and its `:default`/`:+alt`/
   * `:?"message"` suffix, then runs its filters (which therefore always
   * see the value that will actually be used).
   * @param {Fetch} fetch
   * @param {{suffix: import('./nodes.cjs').Suffix | null, filters: import('./nodes.cjs').Filter[]}} ref
   * @param {string} label
   * @returns {Pipeline<unknown>}
   */
  *finish(fetch, ref, label) {
    const { suffix } = ref;
    let value;
    if (fetch.ok) {
      value = suffix?.kind === 'substitute' ? yield* this.resolve(suffix.value) : fetch.value;
    } else if (suffix === null) {
      throw resolveError(`undefined reference ${label}`);
    } else if (suffix.kind === 'default') {
      value = yield* this.resolve(suffix.value);
    } else if (suffix.kind === 'substitute') {
      value = '';
    } else {
      throw resolveError(yield* this.requiredMessage(suffix.message));
    }
    const { filters, secretArg } = yield* this.resolveFilterArgs(ref.filters);
    // A secret's real string is filtered and the result re-wrapped, the same
    // as a tag's argument: the value stored under `*key` is unaffected
    // (CASC.md §4.3), and what is derived from it stays secret.
    const secret = (value instanceof Secret || secretArg) && filters.length > 0;
    const filtered = applyFilters(value instanceof Secret && filters.length > 0 ? value.value : value, filters);
    if (!filtered.ok) throw resolveError(`${label}: ${filtered.message}`);
    return secret ? new Secret(filtered.value) : filtered.value;
  }

  /**
   * The text of a `:?"message"` failure. The message is a double-quoted
   * string, so it may interpolate (CASC.md §7.2); a secret in it shows
   * redacted, since an error message is never redacted later. This once
   * handed the unresolved string to the error.
   * @param {unknown} message
   * @returns {Pipeline<string>}
   */
  *requiredMessage(message) {
    const text = yield* this.resolve(message);
    if (text instanceof Secret) return text.redacted ?? Secret.REDACTED;
    return display(text);
  }

  /**
   * Settles each filter's argument to a string. A double-quoted argument
   * interpolates like any double-quoted string (CASC.md §7.2), which is
   * also how a loop binding reaches one. One built from a secret is used
   * for real, and the filtered result is secret too.
   * @param {import('./nodes.cjs').Filter[]} filters
   * @returns {Pipeline<{filters: Array<{name: string, arg: string | null}>, secretArg: boolean}>}
   */
  *resolveFilterArgs(filters) {
    let secretArg = false;
    const out = [];
    for (const { name, arg } of filters) {
      if (arg === null || typeof arg === 'string') {
        out.push({ name, arg });
        continue;
      }
      let resolved = yield* this.resolve(arg);
      if (resolved instanceof Secret) {
        secretArg = true;
        resolved = resolved.value;
      }
      out.push({ name, arg: display(resolved) });
    }
    return { filters: out, secretArg };
  }
}

/**
 * `${NAME[]}` splitting (CASC.md §7.2): on `,` or `;`, each part trimmed.
 * @param {string} raw
 * @returns {string[]}
 */
function splitEnvList(raw) {
  return raw.split(/[,;]/).map((part) => part.trim());
}

/**
 * Indexes into a list (negative counts from the end); a secret list's
 * element stays secret.
 * @param {unknown} value
 * @param {number | null} index
 * @returns {Fetch}
 */
function applyIndex(value, index) {
  if (index === null) return { ok: true, value };
  if (value instanceof Secret) {
    const inner = applyIndex(value.value, index);
    return inner.ok ? { ok: true, value: new Secret(inner.value) } : inner;
  }
  if (!Array.isArray(value)) return MISSING;
  const i = index < 0 ? value.length + index : index;
  return i >= 0 && i < value.length ? { ok: true, value: value[i] } : MISSING;
}

/**
 * @param {unknown} base
 * @param {unknown} overrides
 * @returns {unknown}
 */
function deepMerge(base, overrides) {
  if (!isPlainObject(overrides)) return overrides;
  /** @type {Record<string, unknown>} */
  const out = {};
  const from = isPlainObject(base) ? base : {};
  for (const key of Object.keys(from)) put(out, key, from[key]);
  for (const key of Object.keys(overrides)) {
    const value = overrides[key];
    if (value === ABSENT) delete out[key];
    else put(out, key, Object.hasOwn(from, key) ? deepMerge(from[key], value) : stripAbsent(value));
  }
  return out;
}

/**
 * Drops `ABSENT` markers from overrides that had no base to apply to.
 * @param {unknown} value
 * @returns {unknown}
 */
function stripAbsent(value) {
  return isPlainObject(value) ? deepMerge({}, value) : value;
}

module.exports = { Resolver };
