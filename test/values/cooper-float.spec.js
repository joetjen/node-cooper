import util from 'node:util';
import { expect } from 'chai';
import fc from 'fast-check';
import { CooperFloat } from '../../src/cooper.js';

describe('CooperFloat (CASC.md §6.3)', () => {
  it('holds a number and is frozen', () => {
    const f = new CooperFloat(2);
    expect(f.value).to.equal(2);
    expect(Object.isFrozen(f)).to.equal(true);
  });

  it('refuses anything that is not a number', () => {
    expect(() => new CooperFloat(/** @type {any} */ ('2.0'))).to.throw(TypeError);
    expect(() => new CooperFloat(/** @type {any} */ (2n))).to.throw(TypeError);
  });

  it('gives its number back through toNumber(), valueOf(), and arithmetic', () => {
    const f = new CooperFloat(2.5);
    expect(f.toNumber()).to.equal(2.5);
    expect(f.valueOf()).to.equal(2.5);
    expect(/** @type {any} */ (f) * 2).to.equal(5);
    expect(CooperFloat.fromNumber(2.5).equals(f)).to.equal(true);
  });

  it('reads as CASC writes a float, always with a fraction', () => {
    expect(String(new CooperFloat(2))).to.equal('2.0');
    expect(`${new CooperFloat(1000)}`).to.equal('1.0e3');
    expect(String(new CooperFloat(-0))).to.equal('-0.0');
    expect(String(new CooperFloat(Infinity))).to.equal('inf');
    expect(String(new CooperFloat(-Infinity))).to.equal('-inf');
  });

  it('serializes to JSON as its number and inspects as CooperFloat(<text>)', () => {
    expect(JSON.stringify({ f: new CooperFloat(2) })).to.equal('{"f":2}');
    expect(util.inspect(new CooperFloat(2))).to.equal('CooperFloat(2.0)');
  });

  it('equals only another float of the same value: never an integer, and 0.0 is not -0.0', () => {
    expect(new CooperFloat(2).equals(new CooperFloat(2))).to.equal(true);
    expect(new CooperFloat(2).equals(2)).to.equal(false);
    expect(new CooperFloat(0).equals(new CooperFloat(-0))).to.equal(false);
  });

  it('toString() reads back as the same float for every finite number', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (n) => {
        expect(Object.is(Number(String(new CooperFloat(n))), n)).to.equal(true);
      })
    );
  });
});
