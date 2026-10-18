import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { expect } from 'chai';

/**
 * The adapter the Cooper Conformance Suite runs this implementation
 * through (`src/conformance.cjs`, `node bin/cooper.js conformance REQUEST
 * ANSWER`): a JSON request in, a JSON answer out, every value in the
 * suite's typed JSON, every error as its CASC.md §9.5 category. Mirrors
 * the Elixir reference's `Cooper.ConformanceTest`.
 */

const require = createRequire(import.meta.url);
const Conformance = require('../../src/conformance.cjs');
const {
  Secret, Tuple, Duration, ByteSize, IPv4, IPv6, LocalDate, LocalTime, LocalDateTime, DateTime, ModuleRef, CooperFloat,
} = require('../../src/cooper.cjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', 'fixtures', 'conformance');
const BIN = path.join(here, '..', '..', 'bin', 'cooper.js');

/** @param {string} name */
const load = (name) => ({ id: `c: ${name}`, operation: 'load', document: path.join(FIXTURES, name) });

/** @param {string} tag @param {...unknown} items */
const tagged = (tag, ...items) => ({ tuple: [{ keyword: tag }, ...items] });

describe('the conformance adapter: a value in the suite\'s typed JSON', () => {
  it('a string, a boolean and null are themselves', () => {
    expect(Conformance.encode(['s', true, false, null])).to.deep.equal(['s', true, false, null]);
  });

  it('an integer is typed, as text, a bigint too', () => {
    expect(Conformance.encode(42)).to.deep.equal({ integer: '42' });
    expect(Conformance.encode(123456789012345678901n)).to.deep.equal({ integer: '123456789012345678901' });
  });

  it('a float keeps a fraction or an exponent, as Elixir writes it', () => {
    expect(Conformance.encode(new CooperFloat(2))).to.deep.equal({ float: '2.0' });
    expect(Conformance.encode(new CooperFloat(1e20))).to.deep.equal({ float: '1.0e20' });
    expect(Conformance.encode(2.5)).to.deep.equal({ float: '2.5' });
  });

  it('an atom is a keyword, a list an array, a tuple a tuple', () => {
    expect(Conformance.encode([Symbol.for('info'), new Tuple([1, Symbol.for('x')])])).to.deep.equal([
      { keyword: 'info' },
      { tuple: [{ integer: '1' }, { keyword: 'x' }] },
    ]);
  });

  it('a map is a list of pairs, in key order', () => {
    expect(Conformance.encode({ b: 1, a: 2 })).to.deep.equal({ map: [['a', { integer: '2' }], ['b', { integer: '1' }]] });
  });

  it('a map orders its keys by their bytes, as Elixir sorts binaries', () => {
    // In UTF-8, U+FF5E (EF BD 9E) sorts before U+1F600 (F0 9F 98 80);
    // JavaScript's own sort compares UTF-16 units, where U+1F600's
    // surrogate D83D sorts before FF5E.
    expect(Conformance.encode({ '\u{FF5E}': 1, '\u{1F600}': 2 }).map.map((/** @type {any[]} */ p) => p[0])).to.deep.equal([
      '\u{FF5E}',
      '\u{1F600}',
    ]);
  });

  it('a duration and a byte size are tagged with their base unit', () => {
    expect(Conformance.encode(new Duration(300000000000n))).to.deep.equal(tagged('casc.duration', { integer: '300000000000' }));
    expect(Conformance.encode(new ByteSize(512n))).to.deep.equal(tagged('casc.bytes', { integer: '512' }));
  });

  it('a secret is tagged, and carries its shown form when partly redacted', () => {
    expect(Conformance.encode(new Secret('s'))).to.deep.equal(tagged('casc.secret', 's'));
    expect(Conformance.encode(new Secret('http://a', 'http://[~~REDACTED~~]'))).to.deep.equal(
      tagged('casc.secret', 'http://a', 'http://[~~REDACTED~~]')
    );
  });

  it('a module is tagged with its name as CASC writes it', () => {
    expect(Conformance.encode(new ModuleRef('Foo.Bar', 'node:path'))).to.deep.equal(tagged('casc.module', 'Foo.Bar'));
  });

  it('infinity is a tagged float', () => {
    expect(Conformance.encode(Infinity)).to.deep.equal(tagged('casc.float', 'inf'));
    expect(Conformance.encode(-Infinity)).to.deep.equal(tagged('casc.float', '-inf'));
  });

  it('an IP address is tagged with its canonical text', () => {
    expect(Conformance.encode(IPv4.parse('10.0.0.1'))).to.deep.equal(tagged('casc.ipv4', '10.0.0.1'));
    expect(Conformance.encode(IPv6.parse('::1'))).to.deep.equal(tagged('casc.ipv6', '::1'));
  });

  it('dates and times are tagged ISO 8601', () => {
    expect(Conformance.encode(new LocalDate(2026, 10, 18))).to.deep.equal(tagged('casc.date', '2026-10-18'));
    expect(Conformance.encode(new LocalTime(7, 32, 0))).to.deep.equal(tagged('casc.time', '07:32:00'));
    expect(Conformance.encode(new LocalDateTime(2026, 10, 18, 7, 32, 0))).to.deep.equal(
      tagged('casc.local-date-time', '2026-10-18T07:32:00')
    );
    expect(Conformance.encode(new DateTime(2026, 10, 18, 7, 32, 0))).to.deep.equal(tagged('casc.date-time', '2026-10-18T07:32:00Z'));
  });

  it('a value with no typed form is refused', () => {
    expect(() => Conformance.encode(NaN)).to.throw(/no typed form/);
  });
});

describe('the conformance adapter: answering a request', () => {
  it('a document that loads answers its result', () => {
    const { results } = Conformance.answer({ cases: [load('plain.casc')] });
    expect(results).to.have.length(1);
    expect(results[0].id).to.equal('c: plain.casc');
    expect(results[0].result).to.deep.equal(
      Conformance.encode({
        a: 1,
        wait: new Duration(300000000000n),
        region: 'eu-west',
        pw: new Secret('s'),
        t: new Tuple([1, Symbol.for('x')]),
      })
    );
  });

  it('a float that is whole stays a float', () => {
    const { results } = Conformance.answer({ cases: [load('floats.casc')] });
    expect(results[0].result).to.deep.equal({
      map: [
        ['big', { float: '1.0e20' }],
        ['half', { float: '2.5' }],
        ['n', { integer: '2' }],
        ['whole', { float: '2.0' }],
      ],
    });
  });

  it('a module the suite names loads, and answers its name', () => {
    const { results } = Conformance.answer({ cases: [load('module.casc')] });
    expect(results[0].result).to.deep.equal({ map: [['formatter', tagged('casc.module', 'Foo.Bar')]] });
  });

  it('a document that is refused answers its category', () => {
    expect(Conformance.answer({ cases: [load('refused.casc')] })).to.deep.equal({
      results: [{ id: 'c: refused.casc', error: 'resolve' }],
    });
  });

  it('a document that is missing answers the import category', () => {
    const { results } = Conformance.answer({ cases: [load('no-such-file.casc')] });
    expect(results[0].error).to.equal('import');
  });

  it('an operation it does not know is an error naming it', () => {
    const { results } = Conformance.answer({ cases: [{ id: 'x', operation: 'dance' }] });
    expect(results[0]).to.deep.equal({ id: 'x', error: 'unknown operation: "dance"' });
  });

  it('a crash on one case answers it and keeps going', () => {
    const { results } = Conformance.answer({
      cases: [{ id: 'bad', operation: 'load', document: 42 }, load('refused.casc')],
    });
    expect(results[0].id).to.equal('bad');
    expect(results[0].error).to.match(/^crash: /);
    expect(results[1]).to.deep.equal({ id: 'c: refused.casc', error: 'resolve' });
  });

  it('answers one result per case, in order', () => {
    const { results } = Conformance.answer({ cases: [load('refused.casc'), load('plain.casc'), load('module.casc')] });
    expect(results.map((/** @type {any} */ r) => r.id)).to.deep.equal(['c: refused.casc', 'c: plain.casc', 'c: module.casc']);
  });

  it('loads with the suite\'s standard options, the same the corpus runs with', () => {
    const opts = Conformance.loadOptions('/somewhere');
    expect(opts.env).to.deep.equal(Conformance.ENV);
    expect(opts.dotenv).to.equal(false);
    expect(opts.root).to.equal('/somewhere');
    expect(Object.keys(opts.resolvers ?? {}).sort()).to.deep.equal(['echo', 'fail']);
    expect(Object.keys(opts.tags ?? {})).to.deep.equal(['twice']);
    expect(Object.keys(opts.importSchemes ?? {})).to.deep.equal(['mem']);
  });
});

describe('the conformance adapter: the files', () => {
  /** @type {string} */
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-conformance-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a request file is answered in an answer file', () => {
    const request = path.join(dir, 'request.json');
    const answer = path.join(dir, 'answer.json');
    fs.writeFileSync(request, JSON.stringify({ cases: [load('refused.casc')] }));

    Conformance.run(request, answer);

    expect(JSON.parse(fs.readFileSync(answer, 'utf8'))).to.deep.equal({ results: [{ id: 'c: refused.casc', error: 'resolve' }] });
  });

  it('bin/cooper.js conformance answers a request file and exits zero', () => {
    const request = path.join(dir, 'request.json');
    const answer = path.join(dir, 'answer.json');
    fs.writeFileSync(request, JSON.stringify({ cases: [load('refused.casc'), load('plain.casc')] }));

    execFileSync(process.execPath, [BIN, 'conformance', request, answer]);

    const { results } = JSON.parse(fs.readFileSync(answer, 'utf8'));
    expect(results.map((/** @type {any} */ r) => r.id)).to.deep.equal(['c: refused.casc', 'c: plain.casc']);
    expect(results[1].result.map[0]).to.deep.equal(['a', { integer: '1' }]);
  });

  it('bin/cooper.js conformance exits non-zero when the request cannot be read', () => {
    const run = spawnSync(process.execPath, [BIN, 'conformance', path.join(dir, 'missing.json'), path.join(dir, 'answer.json')]);
    expect(run.status).to.not.equal(0);
    expect(fs.existsSync(path.join(dir, 'answer.json'))).to.equal(false);
  });

  it('bin/cooper.js conformance exits non-zero when the answer cannot be written', () => {
    const request = path.join(dir, 'request.json');
    fs.writeFileSync(request, JSON.stringify({ cases: [] }));
    const run = spawnSync(process.execPath, [BIN, 'conformance', request, path.join(dir, 'no', 'such', 'answer.json')]);
    expect(run.status).to.not.equal(0);
  });
});
