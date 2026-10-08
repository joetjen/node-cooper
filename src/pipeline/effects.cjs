'use strict';

/**
 * @fileoverview Runs the pipeline's generator functions either
 * synchronously or asynchronously from one implementation.
 *
 * The pipeline calls user code at three extension points -- import-scheme
 * loaders (CASC.md §9.3), resolvers (§9.2), and tags (§9.1). In Node those
 * are often asynchronous (a secrets manager is a network call), which the
 * Elixir implementation never had to consider. Rather than writing every
 * stage twice, each stage is a generator that `yield`s an `Effect` -- "call
 * this function with this argument" -- and one of the two drivers below
 * performs it: `runAsync` awaits whatever comes back, `runSync` refuses a
 * promise with a pointed error. Everything else in the pipeline is plain
 * synchronous code either way.
 */

const CooperError = require('../error.cjs');

/**
 * @typedef {object} Effect
 * @property {(arg: any) => unknown} fn -- the user callback
 * @property {unknown} arg
 * @property {string} what -- e.g. `resolver "vault"`, for error messages
 * @property {import('../error.cjs').Stage} stage
 */

/**
 * @template T
 * @typedef {Generator<Effect, T, unknown>} Pipeline
 */

/**
 * @param {unknown} value
 * @returns {value is PromiseLike<unknown>}
 */
function isThenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (/** @type {any} */ (value).then) === 'function';
}

/**
 * Drives `gen` to completion synchronously.
 * @template T
 * @param {Pipeline<T>} gen
 * @returns {T}
 */
function runSync(gen) {
  let step = gen.next();
  while (!step.done) {
    const effect = step.value;
    let result;
    try {
      result = effect.fn(effect.arg);
    } catch (err) {
      step = gen.throw(err);
      continue;
    }
    if (isThenable(result)) {
      // Never leave the abandoned promise to reject unhandled.
      Promise.resolve(result).catch(() => {});
      step = gen.throw(
        new CooperError(
          `${effect.what} returned a Promise -- use the async API (loadFile/loadString) instead of the *Sync variant`,
          { stage: effect.stage }
        )
      );
      continue;
    }
    step = gen.next(result);
  }
  return step.value;
}

/**
 * Drives `gen` to completion, awaiting each effect's result.
 * @template T
 * @param {Pipeline<T>} gen
 * @returns {Promise<T>}
 */
async function runAsync(gen) {
  let step = gen.next();
  while (!step.done) {
    const effect = step.value;
    let result;
    try {
      result = await effect.fn(effect.arg);
    } catch (err) {
      step = gen.throw(err);
      continue;
    }
    step = gen.next(result);
  }
  return step.value;
}

/**
 * Yields one effect and returns its result -- `yield* call(...)` inside a
 * pipeline generator.
 * @param {(arg: any) => unknown} fn
 * @param {unknown} arg
 * @param {string} what
 * @param {import('../error.cjs').Stage} stage
 * @returns {Pipeline<unknown>}
 */
function* call(fn, arg, what, stage) {
  return yield { fn, arg, what, stage };
}

module.exports = { runSync, runAsync, call, isThenable };
