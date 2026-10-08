'use strict';

/**
 * @fileoverview Filesystem expansion for a bare `import` path (CASC.md
 * §5.1): `{a,b}` brace groups, then `*`, `?`, `[...]`, and `**` against the
 * filesystem. Hand-rolled to keep zero runtime dependencies and to support
 * every Node version in `engines` (`fs.globSync` is newer).
 *
 * Semantics follow Elixir's `Path.wildcard/1`, which the reference
 * implementation uses: `*` and `?` never match a leading `.`, and a `**`
 * segment matches zero or more directories. A segment that merely *starts*
 * with `**` (`**.casc`, as in CASC.md §5.1's own example) is read as
 * `**` followed by the rest -- recursive -- which is what that example
 * means.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Expands every `{a,b}` group, recursively, so `{a,b}/{x,y}` yields four.
 * @param {string} pattern
 * @returns {string[]}
 */
function expandBraces(pattern) {
  const m = /^([\s\S]*?)\{([^{}]+)\}([\s\S]*)$/.exec(pattern);
  if (!m) return [pattern];
  return m[2].split(',').flatMap((alt) => expandBraces(m[1] + alt + m[3]));
}

/**
 * @param {string} segment -- one path segment, without `**`
 * @returns {RegExp}
 */
function segmentRegExp(segment) {
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (c === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close < 0) source += '\\[';
      else {
        source += `[${segment.slice(i + 1, close).replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else source += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  const leadingDot = segment.startsWith('.') ? '' : '(?!\\.)';
  return new RegExp(`^${leadingDot}${source}$`);
}

/**
 * @param {string} segment
 * @returns {boolean}
 */
const isMagic = (segment) => /[*?[]/.test(segment);

/**
 * @param {string} dir
 * @returns {fs.Dirent[]}
 */
function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Every directory under `dir` (itself included), not descending into
 * dot-directories.
 * @param {string} dir
 * @returns {string[]}
 */
function walkDirs(dir) {
  const out = [dir];
  for (const entry of readDir(dir)) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) out.push(...walkDirs(path.join(dir, entry.name)));
  }
  return out;
}

/**
 * @param {string} base -- an existing directory
 * @param {string[]} segments -- the remaining pattern segments
 * @returns {string[]}
 */
function match(base, segments) {
  if (segments.length === 0) return fs.existsSync(base) ? [base] : [];
  const [segment, ...rest] = segments;
  if (segment.startsWith('**')) {
    const remainder = segment === '**' ? rest : [segment.slice(2) === '' ? '*' : `*${segment.slice(2)}`, ...rest];
    if (remainder.length === 0) return walkDirs(base).flatMap((dir) => readDir(dir).filter((e) => !e.name.startsWith('.')).map((e) => path.join(dir, e.name)));
    return walkDirs(base).flatMap((dir) => match(dir, remainder));
  }
  if (!isMagic(segment)) return match(path.join(base, segment), rest);
  const re = segmentRegExp(segment);
  return readDir(base)
    .filter((entry) => re.test(entry.name))
    .flatMap((entry) => match(path.join(base, entry.name), rest));
}

/**
 * Expands `pattern` relative to `root` into the matching file paths,
 * absolute, de-duplicated, and sorted lexicographically.
 * @param {string} pattern
 * @param {string} root
 * @returns {string[]}
 */
function expandImport(pattern, root) {
  const found = new Set();
  for (const expanded of expandBraces(pattern)) {
    const full = path.resolve(root, expanded);
    const { root: fsRoot } = path.parse(full);
    const segments = full.slice(fsRoot.length).split(path.sep).filter((s) => s !== '');
    for (const file of match(fsRoot, segments)) {
      if (fs.statSync(file).isFile()) found.add(file);
    }
  }
  return [...found].sort();
}

module.exports = { expandImport, expandBraces };
