import util from 'node:util';
import { expect } from 'chai';
import fc from 'fast-check';
import { ByteSize } from '../../src/cooper.js';
import { value } from '../support/load.js';

/** CASC.md §6.9's unit table. */
const UNITS = /** @type {const} */ ([
  ['B', 1n],
  ['kB', 1000n],
  ['MB', 1000n ** 2n],
  ['GB', 1000n ** 3n],
  ['TB', 1000n ** 4n],
  ['PB', 1000n ** 5n],
  ['KiB', 1024n],
  ['MiB', 1024n ** 2n],
  ['GiB', 1024n ** 3n],
  ['TiB', 1024n ** 4n],
  ['PiB', 1024n ** 5n],
]);

/** Re-cases `unit` randomly -- matching is case-insensitive. */
const anyCase = (/** @type {string} */ unit) =>
  fc
    .array(fc.boolean(), { minLength: unit.length, maxLength: unit.length })
    .map((flags) => [...unit].map((c, i) => (flags[i] ? c.toUpperCase() : c.toLowerCase())).join(''));

describe('ByteSize (CASC.md §6.9)', () => {
  it('holds a bigint byte count', () => {
    expect(new ByteSize(512n).bytes).to.equal(512n);
  });

  it('rejects a non-bigint', () => {
    expect(() => new ByteSize(/** @type {any} */ (512))).to.throw(TypeError);
  });

  it('is immutable', () => {
    expect(Object.isFrozen(new ByteSize(1n))).to.equal(true);
  });

  it('parse() applies the bare-literal rules', () => {
    expect(ByteSize.parse('512MiB').bytes).to.equal(536_870_912n);
    expect(() => ByteSize.parse('10XB')).to.throw(SyntaxError, /unit/);
    expect(() => ByteSize.parse('MB')).to.throw(SyntaxError, /invalid byte-size/);
  });

  it('converts to and from plain numbers', () => {
    expect(ByteSize.fromNumber(1024).bytes).to.equal(1024n);
    expect(new ByteSize(1024n).toNumber()).to.equal(1024);
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(() => ByteSize.fromNumber(bad), String(bad)).to.throw(RangeError);
    }
  });

  it('equals by byte count', () => {
    expect(ByteSize.parse('1KiB').equals(new ByteSize(1024n))).to.equal(true);
    expect(ByteSize.parse('1kB').equals(new ByteSize(1024n))).to.equal(false);
  });

  it('renders as the base-unit literal in toString/JSON/inspect', () => {
    const b = new ByteSize(536_870_912n);
    expect(String(b)).to.equal('536870912B');
    expect(JSON.stringify(b)).to.equal('"536870912B"');
    expect(util.inspect(b)).to.equal('ByteSize(536870912B)');
  });

  it('toString() is valid CASC that loads back to an equal ByteSize', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 80n }), (n) => {
        const b = new ByteSize(n);
        expect(value(b.toString()).equals(b)).to.equal(true);
      }),
      { numRuns: 50 }
    );
  });
});

describe('byte-size literals at load time (CASC.md §6.9)', () => {
  it('binary units', () => {
    expect(value('512MiB').bytes).to.equal(536_870_912n);
  });

  it('decimal units', () => {
    expect(value('10GB').bytes).to.equal(10_000_000_000n);
  });

  it('fractional numerals', () => {
    expect(value('1.5GiB').bytes).to.equal(1_610_612_736n);
  });

  it('case-insensitive matching', () => {
    expect(value('10gb').bytes).to.equal(10_000_000_000n);
    expect(value('10Gb').bytes).to.equal(10_000_000_000n);
    expect(value('1KIB').bytes).to.equal(1024n);
  });

  it('every unit in the table resolves to its documented multiple', () => {
    for (const [unit, multiple] of UNITS) {
      const v = value(`1${unit}`);
      expect(v, unit).to.be.instanceOf(ByteSize);
      expect(v.bytes, unit).to.equal(multiple);
    }
  });

  it('any integer numeral times any unit, in any letter case, is exact', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.constantFrom(...UNITS).chain(([unit, multiple]) => fc.tuple(anyCase(unit), fc.constant(multiple))),
        (n, [unit, multiple]) => {
          const v = value(`${n}${unit}`);
          expect(v, `${n}${unit}`).to.be.instanceOf(ByteSize);
          expect(v.bytes).to.equal(n * multiple);
        }
      ),
      { numRuns: 200 }
    );
  });
});
