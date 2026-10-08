import util from 'node:util';
import { expect } from 'chai';
import fc from 'fast-check';
import { Duration } from '../../src/cooper.js';
import { value, valueError } from '../support/load.js';

/** Units in strictly descending order, with their nanosecond multiples (CASC.md §6.8). */
const UNITS = /** @type {const} */ ([
  ['d', 86_400_000_000_000n],
  ['h', 3_600_000_000_000n],
  ['m', 60_000_000_000n],
  ['s', 1_000_000_000n],
  ['ms', 1_000_000n],
  ['us', 1_000n],
  ['ns', 1n],
]);

/** A compound duration literal: a non-empty, strictly descending subset of units. */
const compound = fc
  .tuple(
    fc.subarray([...UNITS.keys()], { minLength: 1 }),
    fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { minLength: UNITS.length, maxLength: UNITS.length }),
    fc.boolean()
  )
  .map(([indices, amounts, micro]) => {
    const parts = indices.map((i) => {
      const unit = UNITS[i][0] === 'us' && micro ? 'µs' : UNITS[i][0];
      return { text: `${amounts[i]}${unit}`, ns: amounts[i] * UNITS[i][1] };
    });
    return { text: parts.map((p) => p.text).join(''), ns: parts.reduce((acc, p) => acc + p.ns, 0n) };
  });

describe('Duration (CASC.md §6.8)', () => {
  it('holds a bigint nanosecond count', () => {
    expect(new Duration(5n).nanoseconds).to.equal(5n);
  });

  it('rejects a non-bigint', () => {
    expect(() => new Duration(/** @type {any} */ (5))).to.throw(TypeError);
  });

  it('is immutable', () => {
    expect(Object.isFrozen(new Duration(1n))).to.equal(true);
  });

  it('parse() applies the bare-literal rules', () => {
    expect(Duration.parse('1h30m').nanoseconds).to.equal(5_400_000_000_000n);
    expect(Duration.parse('1.5s').nanoseconds).to.equal(1_500_000_000n);
    expect(() => Duration.parse('30m1h')).to.throw(SyntaxError, /strictly descending/);
    expect(() => Duration.parse('5 minutes')).to.throw(SyntaxError, /invalid duration/);
  });

  it('converts to and from milliseconds and seconds', () => {
    const d = new Duration(1_500_000_000n);
    expect(d.toMilliseconds()).to.equal(1500);
    expect(d.toSeconds()).to.equal(1.5);
    expect(Duration.fromMilliseconds(250).nanoseconds).to.equal(250_000_000n);
    expect(Duration.fromMilliseconds(0.5).nanoseconds).to.equal(500_000n);
    expect(Duration.fromSeconds(2).nanoseconds).to.equal(2_000_000_000n);
  });

  it('equals by nanosecond count', () => {
    expect(Duration.parse('1m').equals(Duration.parse('60s'))).to.equal(true);
    expect(Duration.parse('1m').equals(Duration.parse('61s'))).to.equal(false);
    expect(Duration.parse('1m').equals(60_000_000_000n)).to.equal(false);
  });

  it('renders as the base-unit literal in toString/JSON/inspect', () => {
    const d = new Duration(500_000_000n);
    expect(String(d)).to.equal('500000000ns');
    expect(JSON.stringify(d)).to.equal('"500000000ns"');
    expect(util.inspect(d)).to.equal('Duration(500000000ns)');
  });

  it('toString() is valid CASC that loads back to an equal Duration', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 80n }), (ns) => {
        const d = new Duration(ns);
        expect(Duration.parse(d.toString()).equals(d)).to.equal(true);
        expect(value(d.toString()).equals(d)).to.equal(true);
      }),
      { numRuns: 50 }
    );
  });
});

describe('duration literals at load time (CASC.md §6.8)', () => {
  it('a simple millisecond literal', () => {
    expect(value('500ms').nanoseconds).to.equal(500_000_000n);
  });

  it('a compound literal', () => {
    expect(value('1h30m').nanoseconds).to.equal(5_400_000_000_000n);
  });

  it('a fractional single-unit literal', () => {
    expect(value('1.5h').nanoseconds).to.equal(5_400_000_000_000n);
  });

  it('every unit resolves to the documented nanosecond multiple', () => {
    const table = { '1ns': 1n, '1us': 1_000n, '1µs': 1_000n, '1ms': 1_000_000n, '1s': 1_000_000_000n, '1m': 60_000_000_000n, '1h': 3_600_000_000_000n, '1d': 86_400_000_000_000n };
    for (const [literal, ns] of Object.entries(table)) {
      const v = value(literal);
      expect(v, literal).to.be.instanceOf(Duration);
      expect(v.nanoseconds, literal).to.equal(ns);
    }
  });

  it('allows digit separators (conformance case 913: 1_000ms is valid)', () => {
    expect(value('1_000ms').nanoseconds).to.equal(1_000_000_000n);
  });

  it('holds values beyond Number.MAX_SAFE_INTEGER nanoseconds exactly', () => {
    expect(value('365000d').nanoseconds).to.equal(365_000n * 86_400_000_000_000n);
  });

  it('rejects a fractional component in a compound literal (action stage)', () => {
    const err = valueError('1.5h30m');
    expect(err.stage).to.equal('action');
    expect(err.message).to.match(/integer components/);
  });

  it('rejects out-of-order units (action stage)', () => {
    const err = valueError('30m1h');
    expect(err.stage).to.equal('action');
    expect(err.message).to.match(/strictly descending/);
  });

  it('rejects a repeated unit (action stage)', () => {
    const err = valueError('1h1h');
    expect(err.stage).to.equal('action');
    expect(err.message).to.match(/repeated/);
  });

  it('rejects us and µs together, since they are the same unit', () => {
    expect(valueError('1us1µs').stage).to.equal('action');
  });

  it('any strictly descending compound literal sums its components exactly', () => {
    fc.assert(
      fc.property(compound, ({ text, ns }) => {
        const v = value(text);
        expect(v, text).to.be.instanceOf(Duration);
        expect(v.nanoseconds, text).to.equal(ns);
      }),
      { numRuns: 200 }
    );
  });

  it('a compound literal with its components reversed is rejected', () => {
    fc.assert(
      fc.property(fc.subarray([...UNITS.keys()], { minLength: 2 }), fc.nat({ max: 999 }), (indices, n) => {
        const text = [...indices].reverse().map((i) => `${n}${UNITS[i][0]}`).join('');
        expect(valueError(text).stage, text).to.equal('action');
      }),
      { numRuns: 100 }
    );
  });
});
