'use strict';

/**
 * @fileoverview The pipeline's side of floats -- not part of the public
 * API. A float literal and every float-producing tag yield a
 * `CooperFloat` (`cooper-float.cjs`, public), which the pipeline carries
 * through display, equality, tags, filters, and indexing; a consumer's
 * tag is handed it as it is (CASC.md §7.5). The finished tree alone is
 * passed through `unwrapFloats`: a loaded config holds plain `number`s,
 * the host's single number type.
 *
 * Infinity is not wrapped: `inf` has one spelling and no integer twin to
 * be told apart from.
 */

const CooperFloat = require('./cooper-float.cjs');
const Tuple = require('./tuple.cjs');
const Secret = require('./secret.cjs');
const { isPlainObject } = require('./equality.cjs');
const { formatFloat } = require('./float-format.cjs');

/**
 * Replaces every `CooperFloat` in a resolved value with its plain
 * `number`, rebuilding the containers that hold one (a `Tuple` and a
 * `Secret` are frozen, so they are rebuilt rather than edited).
 * @param {unknown} value
 * @returns {unknown}
 */
function unwrapFloats(value) {
  if (value instanceof CooperFloat) return value.value;
  if (Array.isArray(value)) return value.map(unwrapFloats);
  if (value instanceof Tuple) return new Tuple(value.items.map(unwrapFloats));
  if (value instanceof Secret) return new Secret(unwrapFloats(value.value), value.redacted);
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    // `defineProperty`, not assignment: a `__proto__` key stays an own key.
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, { value: unwrapFloats(value[key]), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

module.exports = { CooperFloat, formatFloat, unwrapFloats };
