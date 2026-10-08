import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { loadStringSync, loadString, CooperError } from '../../src/cooper.js';

/**
 * Helpers for the pipeline/API specs (`test/pipeline`, `test/*.spec.js`).
 * Kept separate from `load.js`, which the value/grammar specs own.
 */

/** The version header every test source is prefixed with. */
export const HEADER = '#@version = 1.0\n';

/** Absolute path of `test/fixtures`. */
export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/**
 * Hermetic defaults: no `.env` files, an empty override layer (note that
 * `process.env` still applies underneath `env`, as it always does -- tests
 * use deliberately unlikely names for anything meant to be unset).
 * @param {object} [opts]
 */
export function hermetic(opts = {}) {
  return { dotenv: false, env: {}, ...opts };
}

/**
 * `loadStringSync` of `HEADER + source`, hermetic.
 * @param {string} source
 * @param {object} [opts]
 * @returns {Record<string, any>}
 */
export function load(source, opts = {}) {
  return loadStringSync(HEADER + source, hermetic(opts));
}

/**
 * `loadString` (async) of `HEADER + source`, hermetic.
 * @param {string} source
 * @param {object} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export function loadAsync(source, opts = {}) {
  return loadString(HEADER + source, hermetic(opts));
}

/**
 * Runs `fn`, asserting it throws a `CooperError` (optionally of `stage`),
 * and returns the error.
 * @param {() => unknown} fn
 * @param {string} [stage]
 * @returns {CooperError}
 */
export function throwsCooper(fn, stage) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected a CooperError to be thrown').to.be.instanceOf(CooperError);
  if (stage !== undefined) expect(/** @type {any} */ (caught).stage, /** @type {Error} */ (caught).message).to.equal(stage);
  return /** @type {CooperError} */ (caught);
}

/**
 * Asserts `promise` rejects with a `CooperError` (optionally of `stage`)
 * and returns the error.
 * @param {Promise<unknown>} promise
 * @param {string} [stage]
 * @returns {Promise<CooperError>}
 */
export async function rejectsCooper(promise, stage) {
  let caught;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected a CooperError rejection').to.be.instanceOf(CooperError);
  if (stage !== undefined) expect(/** @type {any} */ (caught).stage, /** @type {Error} */ (caught).message).to.equal(stage);
  return /** @type {CooperError} */ (caught);
}

/**
 * The error of `load(source, opts)`.
 * @param {string} source
 * @param {object} [opts]
 * @param {string} [stage]
 */
export function loadError(source, opts = {}, stage = undefined) {
  return throwsCooper(() => load(source, opts), stage);
}

/** @param {string} name */
export const atom = (name) => Symbol.for(name);
