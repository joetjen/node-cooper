import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {typeof import('../../src/conformance.cjs')} */
const Conformance = require('../../src/conformance.cjs');

/**
 * The load options every corpus case runs with: the Cooper Conformance
 * Suite's fixed standard, taken from the adapter itself
 * (`src/conformance.cjs`), so the corpus and the suite load with one set
 * of options. They MUST stay identical to `Oracle.opts/1` in
 * `scripts/oracle.exs`, which generated the `*.expected.json` files these
 * are compared against -- with one exception, `modules` (see
 * `Conformance.MODULES` and `DIVERGENCES.md`).
 */
export const ENV = Conformance.ENV;

/**
 * @param {string} dir -- the cases directory (the oracle's `root`)
 * @param {string} file -- the case file
 */
export function options(dir, file) {
  return { ...Conformance.loadOptions(dir), file };
}
