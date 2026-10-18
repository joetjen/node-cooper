#!/usr/bin/env node

/**
 * @fileoverview `cooper` CLI -- one executable with subcommands, the JS
 * analog of `cooper`'s `mix cooper.*` tasks, shaped like the sibling
 * `node-dextrin`'s `dextrin` CLI. Today it has one subcommand:
 *
 *     cooper conformance REQUEST ANSWER
 *
 * the Cooper Conformance Suite adapter (`src/conformance.cjs`, the analog
 * of `mix cooper.conformance`).
 */

import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {typeof import('../src/conformance.cjs')} */
const Conformance = require('../src/conformance.cjs');

const USAGE = `usage: cooper <command> [arguments]

Commands:
  conformance REQUEST ANSWER   Answer a Cooper Conformance Suite request

Run with no command, or an unrecognized one, to see this message.`;

/**
 * Dispatches to the subcommand `argv` names.
 * @param {string[]} argv -- the arguments after the script
 * @returns {void}
 */
function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'conformance':
      return conformance(rest);
    default:
      console.log(USAGE);
      process.exitCode = command === undefined ? 0 : 1;
  }
}

/**
 * `cooper conformance REQUEST ANSWER`: reads the JSON request, answers
 * every case, writes the JSON answer. It exits non-zero only when the
 * adapter itself cannot work -- the request cannot be read, or the answer
 * cannot be written -- never because a case did: a failed case is an
 * answer, and the suite judges it.
 * @param {string[]} args
 * @returns {void}
 */
function conformance(args) {
  if (args.length !== 2) {
    console.error('usage: cooper conformance REQUEST ANSWER');
    process.exitCode = 1;
    return;
  }
  try {
    Conformance.run(args[0], args[1]);
  } catch (err) {
    console.error(`cooper conformance: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
