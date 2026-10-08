/**
 * The load options every conformance case runs with. MUST stay identical
 * to `Oracle.opts/1` in `scripts/oracle.exs`, which generated the
 * `*.expected.json` files these are compared against -- with one
 * exception, `modules` (see `MODULES`).
 */
export const ENV = {
  REGION: 'eu-west',
  PORT: '9090',
  DEBUG: 'true',
  EMPTY: '',
  LIST: 'a, b;c',
  SCHEME: 'HTTPS://',
  PADDED: '  padded  ',
  TOKEN_1: 'tok-one',
  TOKEN_2: 'tok-two',
  FEATURE: 'on',
  WHICH: 'dev',
  FORMATTER: 'Foo.Bar',
  // Set, so case 168 sees one value in every implementation rather than
  // each host's own fallback (MIX_ENV, NODE_ENV, ...).
  COOPER_ENV: 'conformance',
};

/**
 * The one Node-only option. The reference translates a `!module("Name")`
 * name into an Elixir module by convention and needs no mapping; a Node
 * module is a location, not a name, so this port has no convention to
 * fall back on and requires every name in `modules` (CASC.md §7.5). These
 * are exactly the names the corpus loads successfully (cases 163, 920);
 * the oracle renders a module by its name as written, so what each maps
 * to never reaches the comparison. Names the corpus expects to fail
 * (126, 164-167, 914) stay out: they must fail on their shape, mapped or
 * not. See `DIVERGENCES.md`.
 */
const MODULES = {
  'Acme.Payments.StripeClient': './lib/payments/stripe.js',
  'ASCO.HTTPClient': '@asco/http-client',
  Cooper: 'cooper',
  'Foo.Bar': 'node:path',
};

const MEM = {
  base: '#@version = 1\nfrom_mem = true\nshared = "mem"\n',
  vars: '#@version = 1\n@mem_var = "from-mem"\n',
};

/**
 * @param {string} dir -- the cases directory (the oracle's `root`)
 * @param {string} file -- the case file
 */
export function options(dir, file) {
  return {
    env: ENV,
    dotenv: false,
    root: dir,
    file,
    resolvers: {
      echo: (payload) => payload,
      fail: (payload) => {
        throw new Error(`refused ${payload}`);
      },
    },
    tags: {
      // The oracle's `twice`: an integer doubles, a string repeats, and
      // anything else is refused -- a float too, which reaches a tag as a
      // `CooperFloat` (so `!twice(2.0)` fails as in the reference). An
      // integer may be a `bigint`, and doubles exactly like an Elixir one.
      twice: (arg) => {
        if (typeof arg === 'bigint' || (typeof arg === 'number' && Number.isInteger(arg))) {
          const doubled = BigInt(arg) * 2n;
          return Number.isSafeInteger(Number(doubled)) ? Number(doubled) : doubled;
        }
        if (typeof arg === 'string') return arg + arg;
        throw new Error(`cannot double ${String(arg)}`);
      },
    },
    modules: MODULES,
    importSchemes: {
      mem: (rest) => {
        if (!Object.hasOwn(MEM, rest)) throw new Error('enoent');
        return MEM[rest];
      },
    },
  };
}
