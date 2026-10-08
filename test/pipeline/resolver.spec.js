import { expect } from 'chai';
import fc from 'fast-check';
import path from 'node:path';
import { loadFileSync, Duration, ByteSize, CooperFloat, Secret } from '../../src/cooper.js';
import { load, loadError, FIXTURES, atom } from '../support/harness.js';

describe('resolver: @{} variables (CASC.md §7.1)', () => {
  it('a bare reference inside a string resolves to the variable value', () => {
    expect(load('@name = "world"\ngreeting = "hello @{name}"')).to.deep.equal({ greeting: 'hello world' });
  });

  it('a non-string value substituted bare keeps its own type', () => {
    expect(load('@port = 8080\nport = @{port}')).to.deep.equal({ port: 8080 });
  });

  it('a duration, byte size, or IP embedded in a string stringifies instead of failing', () => {
    expect(load('@t = 500ms\n@b = 512MiB\n@ip = 127.0.0.1/32\nv = "timeout=@{t} size=@{b} ip=@{ip}"')).to.deep.equal({
      v: 'timeout=500000000ns size=536870912B ip=127.0.0.1/32',
    });
  });

  it('nil, booleans and atoms interpolate as CASC writes them (CASC.md §7)', () => {
    expect(load('@n = nil\n@t = true\n@a = info\nv = "@{n}|@{t}|@{a}|@{m:nil}"')).to.deep.equal({ v: 'nil|true|info|nil' });
  });

  it('a float interpolates as its shortest round-trip digits, always with a fraction (CASC.md §7)', () => {
    /** @type {Array<[string, string]>} */
    const table = [
      ['1.0', '1.0'],
      ['52.52', '52.52'],
      ['100.0', '100.0'],
      ['1000.0', '1.0e3'],
      ['1200.0', '1.2e3'],
      ['123456.0', '123456.0'],
      ['0.0001', '0.0001'],
      ['0.000123', '1.23e-4'],
      ['1.0e-5', '1.0e-5'],
      ['1.0e20', '1.0e20'],
      ['12345678901234567890.0', '1.2345678901234567e19'],
      ['5.0e-324', '5.0e-324'],
      ['-2.5', '-2.5'],
      ['0.0', '0.0'],
      ['-0.0', '-0.0'],
    ];
    for (const [literal, text] of table) expect(load(`@f = ${literal}\nv = "@{f}"`).v, literal).to.equal(text);
  });

  it('an integer interpolates without a fraction', () => {
    expect(load('@i = 1000\nv = "@{i}"')).to.deep.equal({ v: '1000' });
  });

  it('an offset datetime interpolates as the reference writes it: UTC, a space, its own fraction digits', () => {
    const result = load('@a = 1979-05-27T07:32:00.123456789Z\n@b = 1979-05-27T07:32:00.0+05:30\n@c = 1979-05-27T07:32:00Z\nv = "@{a}|@{b}|@{c}"');
    expect(result).to.deep.equal({ v: '1979-05-27 07:32:00.123456Z|1979-05-27 02:02:00.0Z|1979-05-27 07:32:00Z' });
  });

  it('infinity interpolates as inf and -inf', () => {
    expect(load('@a = inf\n@b = -inf\nv = "@{a} @{b}"')).to.deep.equal({ v: 'inf -inf' });
  });

  it('an undefined variable with no suffix is a resolve error naming it', () => {
    expect(loadError('v = @{missing}', {}, 'resolve').message).to.contain('missing');
  });

  it('a default is used when the variable is undefined', () => {
    expect(load('v = @{missing:42}')).to.deep.equal({ v: 42 });
  });

  it('substitute-if-set (:+alt) yields alt when defined and an empty string when not', () => {
    expect(load('@x = "anything"\nv = "@{x:+alt}"')).to.deep.equal({ v: 'alt' });
    expect(load('v = "@{missing:+alt}"')).to.deep.equal({ v: '' });
  });

  it('required-or-fail (:?"msg") aborts the load with exactly that message', () => {
    expect(loadError('v = @{missing:?"missing name"}', {}, 'resolve').message).to.equal('missing name');
  });

  it('the message of :?"..." is a double-quoted string, so it interpolates (CASC.md §7.2)', () => {
    expect(loadError('@m = "M"\nv = @{n:?"need @{m}"}', {}, 'resolve').message).to.equal('need M');
  });

  it('a secret interpolated into a :?"..." message shows redacted', () => {
    expect(loadError('*pw = "hunter2"\nv = ${COOPER_TEST_UNSET_N:?"no N, pw %{pw}"}', {}, 'resolve').message).to.equal(
      'no N, pw [~~REDACTED~~]'
    );
  });

  it('indexes into a list-valued variable', () => {
    expect(load('@items = ["a", "b", "c"]\nv = @{items[1]}')).to.deep.equal({ v: 'b' });
  });

  it('resolves a variable whose own value is an unresolved reference before substituting it', () => {
    expect(load('@region = ${COOPER_TEST_UNSET_REGION:"eu-west"}\nhost = "db.@{region}.internal"')).to.deep.equal({
      host: 'db.eu-west.internal',
    });
  });

  it('a direct self-reference is an error naming the cycle, not an infinite loop', () => {
    expect(loadError('@a = @{a}\nv = @{a}', {}, 'resolve').message).to.equal('circular @{...} reference: a -> a');
  });

  it('a transitive cycle across two variables names the whole chain', () => {
    expect(loadError('@a = @{b}\n@b = @{a}\nv = @{a}', {}, 'resolve').message).to.equal('circular @{...} reference: a -> b -> a');
  });
});

describe('resolver: ${} environment expansion (CASC.md §7.2)', () => {
  it("reproduces CASC.md's own worked example", () => {
    const source = 'region = ${REGION}\nmax_retries = !int(${MAX_RETRIES:3})\nallowed_hosts = ${ALLOWED_HOSTS[]:["localhost"]}';
    expect(load(source, { env: { REGION: 'eu-west', MAX_RETRIES: '', ALLOWED_HOSTS: '' } })).to.deep.equal({
      region: 'eu-west',
      max_retries: 3,
      allowed_hosts: ['localhost'],
    });
  });

  it('never auto-coerces: a set variable is always a string', () => {
    expect(load('v = ${PORT}', { env: { PORT: '8080' } })).to.deep.equal({ v: '8080' });
  });

  it('an unset variable with no default is a resolve error', () => {
    loadError('v = ${COOPER_TEST_UNSET_X}', {}, 'resolve');
  });

  it('an empty variable is treated as unset and falls to the default', () => {
    expect(load('v = ${EMPTY:fallback}', { env: { EMPTY: '' } })).to.deep.equal({ v: atom('fallback') });
  });

  it('the env option overrides process.env for the names it defines', () => {
    const saved = process.env.COOPER_TEST_LAYER;
    process.env.COOPER_TEST_LAYER = 'from-process';
    try {
      expect(load('a = ${COOPER_TEST_LAYER}')).to.deep.equal({ a: 'from-process' });
      expect(load('a = ${COOPER_TEST_LAYER}', { env: { COOPER_TEST_LAYER: 'from-option' } })).to.deep.equal({ a: 'from-option' });
    } finally {
      if (saved === undefined) delete process.env.COOPER_TEST_LAYER;
      else process.env.COOPER_TEST_LAYER = saved;
    }
  });
});

describe('resolver: %{} config references (CASC.md §7.3)', () => {
  it("reproduces CASC.md's own worked example", () => {
    const source = [
      'server.host = "api.internal"',
      'server.port = 8080',
      'health_check.url = "http://%{server.host}:%{server.port}/health"',
      'admin_email = %{contact.admin:"ops@example.com"}',
    ].join('\n');
    expect(load(source)).to.deep.equal({
      server: { host: 'api.internal', port: 8080 },
      health_check: { url: 'http://api.internal:8080/health' },
      admin_email: 'ops@example.com',
    });
  });

  it('resolves against the final tree even when the target is defined later', () => {
    expect(load('a = %{b}\nb = 1')).to.deep.equal({ a: 1, b: 1 });
  });

  it('resolves to the value an override sigil left behind, not the original', () => {
    expect(load('url = "v=%{tls.min}"\ntls { min = "1.2", max = "1.3" }\n~tls { min = "1.3" }')).to.deep.equal({
      url: 'v=1.3',
      tls: { min: '1.3' },
    });
  });

  it('a genuine cycle is a resolve error with the cycle path (any rotation) in the message', () => {
    const { message } = loadError('a = %{b}\nb = %{c}\nc = %{a}', {}, 'resolve');
    expect(message).to.match(/^circular %\{\.\.\.\} reference: (a|b|c) -> (a|b|c) -> (a|b|c) -> \1$/);
  });

  it('an undefined path without a default is a resolve error', () => {
    loadError('a = %{no.such.path}', {}, 'resolve');
  });
});

describe('resolver: !{resolver:payload} dispatch (CASC.md §7.4, §9.4)', () => {
  it('dispatches to the registered resolver with the payload verbatim', () => {
    const resolvers = { vault: (/** @type {string} */ p) => `resolved:${p}` };
    expect(load('v = !{vault:secret/db/password}', { resolvers })).to.deep.equal({ v: 'resolved:secret/db/password' });
  });

  it('accepts resolvers as a Map as well as a plain object', () => {
    const resolvers = new Map([['vault', (/** @type {string} */ p) => p.length]]);
    expect(load('v = !{vault:abcd}', { resolvers })).to.deep.equal({ v: 4 });
  });

  it('only the first colon splits the name from the payload', () => {
    expect(load('v = !{echo:a:b:c}', { resolvers: { echo: (/** @type {string} */ p) => p } })).to.deep.equal({ v: 'a:b:c' });
  });

  it('an unregistered resolver is a resolve error naming it', () => {
    expect(loadError('v = !{vault:secret/db/password}', {}, 'resolve').message).to.contain('vault');
  });

  it('passes a deeply brace-nested payload through intact', () => {
    expect(load('v = !{vault:{a:{b:{c:1}}}}', { resolvers: { vault: (/** @type {string} */ p) => p } })).to.deep.equal({
      v: '{a:{b:{c:1}}}',
    });
  });

  it('a resolver may return any value type, which is kept as-is', () => {
    const value = { nested: [1, 2] };
    expect(load('v = !{obj:x}', { resolvers: { obj: () => value } }).v).to.deep.equal(value);
  });
});

describe('resolver: !Name(arg) dispatch (CASC.md §7.5, §9.4)', () => {
  it('provides the built-in !int, !float, !bool, !duration and !bytes', () => {
    const result = load('i = !int("42")\nf = !float("3.5")\nb = !bool("true")\nd = !duration("5m")\nz = !bytes("512MiB")');
    expect(result.i).to.equal(42);
    expect(result.f).to.equal(3.5);
    expect(result.b).to.equal(true);
    expect(result.d).to.be.instanceOf(Duration);
    expect(result.d.nanoseconds).to.equal(300_000_000_000n);
    expect(result.z).to.be.instanceOf(ByteSize);
    expect(result.z.bytes).to.equal(536_870_912n);
  });

  it('converts env strings end to end (the port/debug example from §7.2)', () => {
    expect(load('port = !int(${PORT:8080})\ndebug = !bool(${DEBUG:false})', { env: { PORT: '', DEBUG: '' } })).to.deep.equal({
      port: 8080,
      debug: false,
    });
  });

  it('a consumer-registered tag receives the resolved argument', () => {
    const tags = { shout: (/** @type {string} */ a) => a.toUpperCase() };
    expect(load('v = !shout("hi")', { tags })).to.deep.equal({ v: 'HI' });
  });

  it('a registered tag with the same name replaces the built-in', () => {
    expect(load('v = !int("7")', { tags: { int: () => 'mine' } })).to.deep.equal({ v: 'mine' });
  });

  it('an unregistered tag is a resolve error naming it', () => {
    expect(loadError('v = !uuid("x")', {}, 'resolve').message).to.contain('uuid');
  });

  it('!float always yields a float, which interpolates with a fraction', () => {
    const result = load('@a = !float(7)\n@b = !float("1e3")\n@c = !float(" 2 ")\nv = "@{a} @{b} @{c}"\nf = @{a}');
    expect(result).to.deep.equal({ v: '7.0 1.0e3 2.0', f: 7 });
  });

  it('!float refuses text that is not a whole number or a float', () => {
    for (const text of ['1.', '.5', '1_000.0', 'inf']) loadError(`v = !float("${text}")`, {}, 'resolve');
  });

  it('!int refuses a float, even one with no fractional part', () => {
    expect(loadError('v = !int(2.0)', {}, 'resolve').message).to.contain('cannot convert 2.0 to an integer');
    loadError('v = !int("2.0")', {}, 'resolve');
  });

  it('a consumer-registered tag receives a float as a CooperFloat, so it can tell 2.0 from 2', () => {
    /** @type {unknown[]} */
    const seen = [];
    const tags = { see: (/** @type {unknown} */ a) => (seen.push(a), 'ok') };
    load('a = !see(2.0)\nb = !see(2)\nc = !see(!float(7))', { tags });
    expect(seen[0]).to.be.instanceOf(CooperFloat);
    expect(/** @type {CooperFloat} */ (seen[0]).value).to.equal(2);
    expect(seen[1]).to.equal(2);
    expect(seen[2]).to.be.instanceOf(CooperFloat);
  });

  it('a float nested in a list, tuple, map, or secret reaches a consumer tag wrapped too', () => {
    /** @type {any[]} */
    const seen = [];
    const tags = { see: (/** @type {unknown} */ a) => (seen.push(a), 'ok') };
    load('@s = 1.5\n*k = @{s}\nm { x = 5.0 }\na = !see([2.0, (3.0, 4), %{m}, %{k}])', { tags });
    const [list] = seen;
    expect(list[0]).to.be.instanceOf(CooperFloat);
    expect(list[1].items[0]).to.be.instanceOf(CooperFloat);
    expect(list[1].items[1]).to.equal(4);
    expect(list[2].x).to.be.instanceOf(CooperFloat);
    expect(list[3]).to.be.instanceOf(Secret);
    expect(list[3].value).to.be.instanceOf(CooperFloat);
  });

  it('a secret float argument reaches a consumer tag unwrapped from the secret but still a CooperFloat', () => {
    /** @type {unknown[]} */
    const seen = [];
    const tags = { see: (/** @type {unknown} */ a) => (seen.push(a), 'ok') };
    load('*k = 2.0\na = !see(%{k})', { tags });
    expect(seen[0]).to.be.instanceOf(CooperFloat);
  });

  it('a CooperFloat a consumer tag returns stays a float in the load, and a plain number in the result', () => {
    const tags = { half: (/** @type {number} */ n) => new CooperFloat(Number(n) / 2), same: (/** @type {unknown} */ a) => a };
    const result = load('@h = !half(4)\n@s = !same(3.0)\nv = "@{h} @{s}"\nh = @{h}\nl = [!same(1.0)]\n-l = [1]', { tags });
    expect(result).to.deep.equal({ v: '2.0 3.0', h: 2, l: [1] });
  });

  it('a consumer tag that refuses a float, like the oracle\'s !twice, fails the load (conformance case 175)', () => {
    const tags = {
      twice: (/** @type {unknown} */ n) => {
        if (typeof n === 'number' && Number.isInteger(n)) return n * 2;
        throw new Error(`cannot double ${String(n)}`);
      },
    };
    expect(load('v = !twice(2)', { tags })).to.deep.equal({ v: 4 });
    expect(loadError('v = !twice(2.0)', { tags }, 'resolve').message).to.contain('cannot double 2.0');
  });

  it('a built-in conversion that fails is a resolve error', () => {
    loadError('v = !int("forty-two")', {}, 'resolve');
    loadError('v = !bool("maybe")', {}, 'resolve');
  });

  it('!bool reads every spelling a boolean arrives in from an environment', () => {
    const spellings = { true: true, 1: true, yes: true, on: true, false: false, 0: false, no: false, off: false };
    for (const [text, value] of Object.entries(spellings)) {
      expect(load('v = !bool(${B})', { env: { B: text } }), text).to.deep.equal({ v: value });
    }
  });

  it('!bool refuses anything else, upper case included', () => {
    for (const text of ['TRUE', 'Yes', '2', 'y', '']) {
      loadError(`v = !bool("${text}")`, {}, 'resolve');
    }
  });
});

describe('resolver: for-loop `from` end to end (CASC.md §5.5)', () => {
  it('the base resolves and the body deep-merges on top, per replica', () => {
    const source = [
      'defaults.replica { cpu = 1, memory_mb = 512 }',
      '@instances = ["a", "b", "c"]',
      'for @instance in @{instances} from defaults.replica as replicas."@{instance}" {',
      '  cpu = 2',
      '}',
    ].join('\n');
    expect(load(source)).to.deep.equal({
      defaults: { replica: { cpu: 1, memory_mb: 512 } },
      replicas: {
        a: { cpu: 2, memory_mb: 512 },
        b: { cpu: 2, memory_mb: 512 },
        c: { cpu: 2, memory_mb: 512 },
      },
    });
  });
});

describe('resolver: combined fixture (imports + variables + env + config refs + loops)', () => {
  it('produces the exact expected result end to end', () => {
    const result = loadFileSync(path.join(FIXTURES, 'resolver', 'main.casc'), {
      dotenv: false,
      cache: false,
      env: { EXTRA_TAG: 'prod' },
    });
    expect(result).to.deep.equal({
      base: { name: 'base-service' },
      service: { name: 'base-service', tag: 'prod' },
      replicas: { 0: { cpu: 1 }, 1: { cpu: 1 } },
    });
  });
});

describe('resolver: ${NAME[]} list splitting (CASC.md §7.2)', () => {
  it('splits on "," and ";", trimming each part', () => {
    expect(load('v = ${L[]}', { env: { L: ' a, b;c ' } })).to.deep.equal({ v: ['a', 'b', 'c'] });
  });

  it('indexes into the split list, with a default when out of range', () => {
    expect(load('v = ${L[1]}\nw = ${L[9]:"none"}', { env: { L: 'a;b' } })).to.deep.equal({ v: 'b', w: 'none' });
  });

  it('an unset or empty list variable falls back to the list default', () => {
    expect(load('v = ${L[]:["localhost"]}', { env: { L: '' } })).to.deep.equal({ v: ['localhost'] });
  });

  it('property: joining trimmed items with random separators and padding splits back to the items', () => {
    const item = fc.string({ unit: fc.constantFrom('a', 'b', 'Z', '0', '-', '_', '.', '/'), minLength: 1, maxLength: 6 });
    const pad = fc.string({ unit: fc.constant(' '), maxLength: 2 });
    const part = fc.record({ item, before: pad, after: pad, sep: fc.constantFrom(',', ';') });
    fc.assert(
      fc.property(fc.array(part, { minLength: 1, maxLength: 8 }), (parts) => {
        const raw = parts.map((p, i) => `${p.before}${p.item}${p.after}${i < parts.length - 1 ? p.sep : ''}`).join('');
        const items = parts.map((p) => p.item);
        expect(load('v = ${L[]}', { env: { L: raw } })).to.deep.equal({ v: items });
        const i = items.length - 1;
        expect(load(`v = \${L[${i}]}`, { env: { L: raw } })).to.deep.equal({ v: items[i] });
      }),
      { numRuns: 200 }
    );
  });
});

describe('resolver: ${?NAME} statement guards (CASC.md §7.2)', () => {
  it("reproduces the spec's worked example: the guarded statement is skipped when unset", () => {
    const source = [
      'region = ${REGION}',
      'max_retries = !int(${MAX_RETRIES:3})',
      '${?FEATURE_FLAG}',
      'enabled = true',
      'allowed_hosts = ${ALLOWED_HOSTS[]:["localhost"]}',
    ].join('\n');
    expect(load(source, { env: { REGION: 'eu-west', MAX_RETRIES: '', FEATURE_FLAG: '', ALLOWED_HOSTS: '' } })).to.deep.equal({
      region: 'eu-west',
      max_retries: 3,
      allowed_hosts: ['localhost'],
    });
  });

  it('the guarded statement is evaluated when the variable is set and non-empty', () => {
    expect(load('${?FEATURE_FLAG}\nenabled = true', { env: { FEATURE_FLAG: '1' } })).to.deep.equal({ enabled: true });
  });

  it('an empty value counts as unset', () => {
    expect(load('${?FEATURE_FLAG}\nenabled = true', { env: { FEATURE_FLAG: '' } })).to.deep.equal({});
  });

  it('guards only the one statement immediately after it', () => {
    expect(load('${?COOPER_TEST_UNSET_G}\nskipped = true\nkept = 1')).to.deep.equal({ kept: 1 });
  });

  it("a skipped statement's content is never evaluated -- an unregistered tag inside it does not fail", () => {
    expect(load('${?COOPER_TEST_UNSET_G}\nv = !nonexistent_tag("x")\nkept = 1')).to.deep.equal({ kept: 1 });
  });

  it('may guard a whole block on the same line', () => {
    expect(load('${?FLAG} feature { on = true }', { env: { FLAG: 'yes' } })).to.deep.equal({ feature: { on: true } });
  });
});

describe('resolver: cases the reference once got wrong (test/conformance/cases/9xx-div-*)', () => {
  it('a disabled variable declaration has no effect at all (903)', () => {
    expect(load('#@x = 1\ny = @{x:"undeclared"}')).to.deep.equal({ y: 'undeclared' });
  });

  it('a disabled import has no effect at all, not even a read', () => {
    expect(load('#import "does-not-exist.casc"\nk = 1')).to.deep.equal({ k: 1 });
  });

  it('a private variable may reference another private variable (904)', () => {
    expect(load('@*a = 1\n@*b = "v@{a}"\nx = @{b}')).to.deep.equal({ x: 'v1' });
  });

  it('interpolated keys resolve @{}, ${} and resolvers (906)', () => {
    const result = load('@x = "k"\n"@{x}" = 1\na."${R}".b = 2\n"!{echo:q}" = 3', {
      env: { R: 'eu-west' },
      resolvers: { echo: (/** @type {string} */ p) => p },
    });
    expect(result).to.deep.equal({ k: 1, a: { 'eu-west': { b: 2 } }, q: 3 });
  });

  it('an interpolated key segment may not resolve to a string with a dot in it (CASC.md §4.2)', () => {
    expect(loadError('@k = "a.b"\n"@{k}" = 1', {}, 'resolve').message).to.contain('more than one path segment');
    expect(loadError('@f = 1.5\n"k-@{f}" = 1', {}, 'resolve').message).to.contain('"k-1.5"');
  });

  it('an interpolated key segment may not resolve to an empty string (CASC.md §4.2)', () => {
    expect(loadError('@k = ""\nout."@{k}" = 1', {}, 'resolve').message).to.contain('empty string');
  });

  it('a written-out dotted key segment is still one segment', () => {
    expect(load('"a.b" = 1')).to.deep.equal({ 'a.b': 1 });
  });

  it('nil in an interpolated key segment reads as nil', () => {
    expect(load('@n = nil\n"k-@{n}" = 1')).to.deep.equal({ 'k-nil': 1 });
  });

  it('a %{} in a key is a resolve error (the tree does not exist yet)', () => {
    loadError('a = "z"\n"%{a}" = 1', {}, 'resolve');
  });

  it('interpolating a list, map or tuple into a string is a resolve error (908)', () => {
    expect(loadError('@l = [1, 2]\nb = "x@{l}"', {}, 'resolve').message).to.contain('list');
    expect(loadError('m { a = 1 }\nb = "x%{m}"', {}, 'resolve').message).to.contain('map');
    expect(loadError('@t = (1, 2)\nb = "x@{t}"', {}, 'resolve').message).to.contain('tuple');
  });

  it('a list default interpolated into a string is a resolve error (918)', () => {
    loadError('x = "${COOPER_TEST_UNSET_L:[a, b]}"', {}, 'resolve');
  });

  it('${X:+alt} is the substitute form, also with a numeric alt (910)', () => {
    expect(load('set = ${PORT:+1}\nunset = ${COOPER_TEST_UNSET_P:+1}', { env: { PORT: '9090' } })).to.deep.equal({ set: 1, unset: '' });
  });
});
