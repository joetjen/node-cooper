import { loadStringSync, CooperError } from '../../src/cooper.js';

/**
 * Options every unit test loads with: no `.env` files and an explicit,
 * empty-by-default environment, so the real process environment can never
 * leak into a result.
 * @param {Record<string, string>} [env]
 * @returns {{dotenv: false, env: Record<string, string>}}
 */
export function isolated(env = {}) {
  return { dotenv: false, env };
}

/**
 * Loads `body` under a version header, with isolated options.
 * @param {string} body
 * @param {Record<string, string>} [env]
 * @returns {Record<string, any>}
 */
export function load(body, env = {}) {
  return loadStringSync(`#@version = 1.0\n${body}`, isolated(env));
}

/**
 * The loaded value of `v = <literal>`.
 * @param {string} literal
 * @param {Record<string, string>} [env]
 * @returns {any}
 */
export function value(literal, env = {}) {
  return load(`v = ${literal}`, env).v;
}

/**
 * Runs `fn`, expecting it to throw a `CooperError`, and returns it.
 * @param {() => unknown} fn
 * @returns {CooperError}
 */
export function cooperError(fn) {
  try {
    fn();
  } catch (err) {
    if (err instanceof CooperError) return err;
    throw new Error(`expected a CooperError, got ${String(err)}`, { cause: err });
  }
  throw new Error('expected a CooperError, but nothing was thrown');
}

/**
 * The `CooperError` loading `v = <literal>` throws.
 * @param {string} literal
 * @returns {CooperError}
 */
export function valueError(literal) {
  return cooperError(() => value(literal));
}
