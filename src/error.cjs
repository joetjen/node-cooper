'use strict';

/**
 * @fileoverview One error type for every `cooper` failure mode -- lexing,
 * parsing, loop expansion, imports, merging, reference resolution, and
 * `.env` loading alike -- mirroring the Elixir implementation's reuse of
 * one `%Ichor.Error{stage: ...}` shape across every pipeline stage.
 *
 * **API-shape divergence from Elixir, deliberate**: `Cooper.load_file/2`
 * returns `{:ok, _} | {:error, %Ichor.Error{}}` tuples, idiomatic in an
 * Elixir/`with`-based codebase. `node-cooper` throws (or rejects with)
 * `CooperError` instead -- idiomatic JS, the same convention `JSON.parse`
 * and the sibling `node-dextrin` port follow.
 */

/**
 * The pipeline stage that produced an error. Identical to the Elixir
 * implementation's `:stage` atoms, so an error reads the same in both.
 *
 * @typedef {'lexer' | 'parser' | 'action' | 'loop' | 'import' | 'merge' | 'resolve' | 'dotenv' | 'unknown'} Stage
 */

class CooperError extends Error {
  /**
   * @param {string} message
   * @param {{stage?: Stage, file?: string, line?: number, column?: number, offset?: number, cause?: unknown}} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = 'CooperError';
    /** @type {Stage} */
    this.stage = details.stage ?? 'unknown';
    /**
     * The file the error was raised in, when the source has one.
     * @type {string | undefined}
     */
    this.file = details.file;
    /**
     * 1-based line of a lexer/parser error.
     * @type {number | undefined}
     */
    this.line = details.line;
    /**
     * 1-based column of a lexer/parser error.
     * @type {number | undefined}
     */
    this.column = details.column;
    /**
     * 0-based offset (UTF-16 code units) of a lexer/parser error.
     * @type {number | undefined}
     */
    this.offset = details.offset;
  }

  /**
   * Wraps any thrown value into a `CooperError`, passing an existing one
   * through untouched, so callers only ever have one error type to catch.
   *
   * @param {unknown} err
   * @param {Stage} stage
   * @returns {CooperError}
   */
  static wrap(err, stage) {
    if (err instanceof CooperError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new CooperError(message, { stage, cause: err });
  }
}

module.exports = CooperError;
