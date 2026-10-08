import { createRequire } from 'node:module';
import { expect } from 'chai';
import fc from 'fast-check';
import { CooperError } from '../../src/cooper.js';
import { load } from '../support/load.js';

const require = createRequire(import.meta.url);
const { parseInterpolated } = require('../../src/grammar/interp.cjs');
const { VarRef, EnvRef, ConfigRef, ResolverRef, TaggedRef } = require('../../src/pipeline/nodes.cjs');
const { CooperFloat } = require('../../src/values/float.cjs');

const SCOPE = '(source)';

/** @param {string} text */
const segments = (text) => parseInterpolated(text, SCOPE);

/**
 * The one reference a text made of a single reference parses to.
 * @param {string} text
 */
function only(text) {
  const parsed = segments(text);
  expect(parsed, text).to.have.length(1);
  return parsed[0];
}

/**
 * @param {string} name
 * @param {{index?: number | null, suffix?: unknown, filters?: unknown[]}} [fields]
 */
const varRef = (name, { index = null, suffix = null, filters = [] } = {}) => ({ name, index, suffix, filters, scope: SCOPE });

describe('interp: plain text', () => {
  it('text with no reference is one literal segment', () => {
    expect(segments('hello world')).to.deep.equal(['hello world']);
  });

  it('empty text has no segments', () => {
    expect(segments('')).to.deep.equal([]);
  });

  it('lone sigil characters that do not open a reference stay literal', () => {
    expect(segments('a @ b $ c % d ! e {f}')).to.deep.equal(['a @ b $ c % d ! e {f}']);
    expect(segments('mail@example.com costs $5 at 50%')).to.deep.equal(['mail@example.com costs $5 at 50%']);
  });

  it('any text without a reference opener comes back unchanged', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        fc.pre(!/[@$%!]\{|![a-zA-Z][a-zA-Z0-9_+\-]*[?!]?\(/.test(text));
        expect(segments(text)).to.deep.equal(text === '' ? [] : [text]);
      })
    );
  });

  it('never throws anything but a CooperError on arbitrary text', () => {
    const chars = fc.constantFrom(...'@$%!{}()[]:?+|"\'\\ ,.abcxyz019_'.split(''));
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: chars, maxLength: 40 })), (text) => {
        try {
          segments(text);
        } catch (err) {
          if (!(err instanceof CooperError)) throw err;
          expect(['lexer', 'action']).to.include(err.stage);
        }
      }),
      { numRuns: 2000 }
    );
  });

  it('literal runs and references re-join to the original text', () => {
    const piece = fc.oneof(
      fc.stringMatching(/^[a-z :/.-]{1,8}$/),
      fc.constantFrom('@{a}', '${B}', '%{c.d}', '!{v:x}', '!int(5)', '@{e:"f"}', '${G[]}')
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 8 }), (pieces) => {
        const text = pieces.join('');
        const parsed = segments(text);
        const refs = parsed.filter((/** @type {unknown} */ s) => typeof s !== 'string');
        expect(refs.length).to.equal(pieces.filter((p) => /[{(]/.test(p)).length);
        expect(parsed.filter((/** @type {unknown} */ s) => typeof s === 'string').join('')).to.equal(
          pieces.filter((p) => !/[{(]/.test(p)).join('')
        );
      })
    );
  });
});

describe('interp: variables (CASC.md §7.1)', () => {
  it('a bare reference, stamped with the scope it was written in', () => {
    const ref = only('@{name}');
    expect(ref).to.be.instanceOf(VarRef);
    expect(ref).to.deep.include(varRef('name'));
  });

  it('with a default', () => {
    expect(only('@{name:"fallback"}')).to.deep.include(varRef('name', { suffix: { kind: 'default', value: 'fallback' } }));
  });

  it('substitute-if-set', () => {
    expect(only('@{name:+alt}')).to.deep.include(varRef('name', { suffix: { kind: 'substitute', value: Symbol.for('alt') } }));
  });

  it('required-or-fail', () => {
    expect(only('@{name:?"missing name"}')).to.deep.include(varRef('name', { suffix: { kind: 'required', message: 'missing name' } }));
  });

  it('indexed, with and without a default', () => {
    expect(only('@{name[2]}')).to.deep.include(varRef('name', { index: 2 }));
    expect(only('@{name[2]:0}')).to.deep.include(varRef('name', { index: 2, suffix: { kind: 'default', value: 0 } }));
  });

  it('embedded in a string: literal runs and refs, in order', () => {
    const parsed = segments('https://@{domain}:@{port}');
    expect(parsed).to.have.length(4);
    expect(parsed[0]).to.equal('https://');
    expect(parsed[1]).to.deep.include(varRef('domain'));
    expect(parsed[2]).to.equal(':');
    expect(parsed[3]).to.deep.include(varRef('port'));
  });
});

describe('interp: environment expansion (CASC.md §7.2)', () => {
  it('a bare reference', () => {
    const ref = only('${REGION}');
    expect(ref).to.be.instanceOf(EnvRef);
    expect(ref).to.deep.include({ name: 'REGION', index: null, list: false, suffix: null });
  });

  it('with a default', () => {
    expect(only('${MAX_RETRIES:3}')).to.deep.include({ name: 'MAX_RETRIES', suffix: { kind: 'default', value: 3 } });
  });

  it('substitute-if-set', () => {
    expect(only('${FEATURE:+on}')).to.deep.include({ name: 'FEATURE', suffix: { kind: 'substitute', value: Symbol.for('on') } });
  });

  it('required-or-fail', () => {
    expect(only('${TOKEN:?"missing token"}')).to.deep.include({ name: 'TOKEN', suffix: { kind: 'required', message: 'missing token' } });
  });

  it('list form with a list default', () => {
    expect(only('${ALLOWED_HOSTS[]:["localhost"]}')).to.deep.include({
      name: 'ALLOWED_HOSTS',
      index: null,
      list: true,
      suffix: { kind: 'default', value: ['localhost'] },
    });
  });

  it('indexed form', () => {
    expect(only('${HOSTS[0]:default}')).to.deep.include({ name: 'HOSTS', index: 0, list: false, suffix: { kind: 'default', value: Symbol.for('default') } });
  });
});

describe('interp: config references (CASC.md §7.3)', () => {
  it('a bare reference splits its path on dots', () => {
    const ref = only('%{server.host}');
    expect(ref).to.be.instanceOf(ConfigRef);
    expect(ref).to.deep.include({ path: ['server', 'host'], index: null, suffix: null });
  });

  it("with a quoted-string default, matching CASC.md's own example", () => {
    expect(only('%{contact.admin:"ops@example.com"}')).to.deep.include({ path: ['contact', 'admin'], suffix: { kind: 'default', value: 'ops@example.com' } });
  });

  it('embedded in a string alongside another config ref', () => {
    const parsed = segments('http://%{server.host}:%{server.port}/health');
    expect(parsed.map((/** @type {any} */ s) => (typeof s === 'string' ? s : s.path.join('.')))).to.deep.equal([
      'http://',
      'server.host',
      ':',
      'server.port',
      '/health',
    ]);
  });
});

describe('interp: extensible resolution (CASC.md §7.4)', () => {
  it('splits on the first colon, payload verbatim', () => {
    const ref = only('!{vault:secret/db/password}');
    expect(ref).to.be.instanceOf(ResolverRef);
    expect(ref).to.deep.include({ name: 'vault', payload: 'secret/db/password' });
  });

  it('a payload containing its own colon stays intact', () => {
    expect(only('!{vault:secret:db:password}')).to.deep.include({ name: 'vault', payload: 'secret:db:password' });
  });

  it('a payload nesting braces to any depth', () => {
    expect(only('!{vault:{a:{b:{c:1}}}}')).to.deep.include({ name: 'vault', payload: '{a:{b:{c:1}}}' });
  });

  it('a resolver reference with no colon is an action-stage error', () => {
    let err;
    try {
      segments('!{vault}');
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(CooperError);
    expect(err).to.have.property('stage', 'action');
  });
});

describe('interp: tagged values (CASC.md §7.5)', () => {
  it('a tag with a plain string argument', () => {
    const ref = only('!duration("5m")');
    expect(ref).to.be.instanceOf(TaggedRef);
    expect(ref).to.deep.include({ name: 'duration', arg: '5m' });
  });

  it('a tag with a number argument', () => {
    expect(only('!int(42)')).to.deep.include({ name: 'int', arg: 42 });
  });
});

describe('interp: the reduced default-value grammar', () => {
  it('nil, booleans, numbers, strings, atoms, lists', () => {
    const defaultOf = (/** @type {string} */ raw) => only(`\${X:${raw}}`).suffix.value;
    expect(defaultOf('nil')).to.equal(null);
    expect(defaultOf('true')).to.equal(true);
    expect(defaultOf('false')).to.equal(false);
    expect(defaultOf('-5')).to.equal(-5);
    expect(defaultOf('9007199254740993')).to.equal(9007199254740993n);
    expect(defaultOf('2.5')).to.deep.equal(new CooperFloat(2.5));
    expect(defaultOf('"a\\"b"')).to.equal('a"b');
    expect(defaultOf("'lit'")).to.equal('lit');
    expect(defaultOf('word')).to.equal(Symbol.for('word'));
    expect(defaultOf("[a, 'b c', \"d\", 1]")).to.deep.equal([Symbol.for('a'), 'b c', 'd', 1]);
  });
});

describe('interp: filters (CASC.md §7.2 Filters)', () => {
  it('a filter chain, with quoted args that may contain a pipe', () => {
    expect(only('@{x | upcase | default: "a|b"}').filters).to.deep.equal([
      { name: 'upcase', arg: null },
      { name: 'default', arg: 'a|b' },
    ]);
  });

  it('a single-quoted filter argument is literal', () => {
    expect(only("${X | default: 'q'}").filters).to.deep.equal([{ name: 'default', arg: 'q' }]);
  });

  it('a default containing a pipe is not mistaken for a filter', () => {
    const ref = only('${N:"a|b"}');
    expect(ref.filters).to.deep.equal([]);
    expect(ref.suffix).to.deep.equal({ kind: 'default', value: 'a|b' });
  });
});

describe('interp: errors', () => {
  it('an unterminated reference is a lexer-stage error', () => {
    for (const text of ['@{name', 'x ${NAME', '%{a.b', '!{vault:{x}', '!int(5']) {
      let err;
      try {
        segments(text);
      } catch (e) {
        err = e;
      }
      expect(err, text).to.be.instanceOf(CooperError);
      expect(err, text).to.have.property('stage', 'lexer');
    }
  });
});

describe('interpolated strings at load time (CASC.md §7)', () => {
  it('a variable embedded in a string resolves', () => {
    expect(load('@domain = "example.com"\n@port = 8080\nv = "https://@{domain}:@{port}"').v).to.equal('https://example.com:8080');
  });

  it('a config reference embedded in a string resolves against the final tree', () => {
    const r = load('v = "http://%{server.host}:%{server.port}/health"\nserver { host = "h", port = 80 }');
    expect(r.v).to.equal('http://h:80/health');
  });

  it('an env reference embedded in a string resolves from the env option only', () => {
    expect(load('v = "region=${REGION}"', { REGION: 'eu-west' }).v).to.equal('region=eu-west');
    expect(load('v = "region=${REGION:none}"').v).to.equal('region=none');
  });

  it('a double-quoted string with no reference stays a plain string', () => {
    expect(load('v = "hello world"').v).to.equal('hello world');
  });

  it('single-quoted and triple-quoted strings never interpolate', () => {
    expect(load("v = 'hello @{name}'").v).to.equal('hello @{name}');
    expect(load('v = """\n    hello @{name}\n    """').v).to.equal('hello @{name}\n');
  });
});
