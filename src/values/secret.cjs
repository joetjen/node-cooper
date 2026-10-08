'use strict';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** The blanket marker a whole-value secret displays as. */
const REDACTED = '[~~REDACTED~~]';

/**
 * Wraps a secret value (CASC.md §4.3's `*key`-prefixed keys) in the result
 * `loadFile`/`loadString` return, so it never leaks by accident:
 * `String(secret)`, template literals, `JSON.stringify`, and
 * `util.inspect`/`console.log` all render the redacted text regardless of
 * the wrapped value. Reach the real value deliberately via `reveal()` (or
 * the `value` property) -- redaction is only ever a display-time concern,
 * never a barrier to the application's own deliberate use of the value.
 *
 * Mirrors `Cooper.Secret`. One JS-specific hardening on top: `value` is a
 * *non-enumerable* property, so object spread, `Object.keys`,
 * `structuredClone`, and logging libraries that walk enumerable keys don't
 * copy the real value out either.
 *
 * ## Partial redaction
 *
 * A secret embedded inside a larger interpolated string
 * (`"postgres://user:%{database.password}@host"`) redacts only the
 * embedded portion -- the result displays as
 * `"postgres://user:[~~REDACTED~~]@host"`, each secret at its own position.
 * `redacted` carries that precomputed display text; `null` (an ordinary
 * whole-value secret) falls back to the blanket `[~~REDACTED~~]` marker.
 * Either way `value`/`reveal()` give back the real, fully unmasked value.
 */
class Secret {
  /**
   * @param {unknown} value
   * @param {string | null} [redacted]
   */
  constructor(value, redacted = null) {
    /** @type {unknown} */
    this.value = undefined;
    Object.defineProperty(this, 'value', { value, enumerable: false, writable: false, configurable: false });
    /**
     * Display text for a partially redacted string, or `null` for a
     * whole-value secret.
     * @type {string | null}
     */
    this.redacted = redacted;
    Object.freeze(this);
  }

  /**
   * The real, fully unmasked value underneath.
   * @returns {unknown}
   */
  reveal() {
    return this.value;
  }

  /**
   * Unwraps `value` if it is a `Secret`, returning anything else unchanged
   * -- handy for code that accepts either.
   * @param {unknown} value
   * @returns {unknown}
   */
  static reveal(value) {
    return value instanceof Secret ? value.value : value;
  }

  /** @returns {string} the redacted display text */
  toString() {
    return this.redacted ?? REDACTED;
  }

  /** @returns {string} the redacted display text, never the real value */
  toJSON() {
    return this.toString();
  }

  /** @returns {string} */
  [Symbol.toPrimitive]() {
    return this.toString();
  }

  /**
   * @param {number} _depth
   * @param {object} options
   * @param {(value: unknown, options: object) => string} inspect
   * @returns {string}
   */
  [INSPECT](_depth, options, inspect) {
    return this.redacted === null ? REDACTED : inspect(this.redacted, options);
  }
}

Secret.REDACTED = REDACTED;

module.exports = Secret;
