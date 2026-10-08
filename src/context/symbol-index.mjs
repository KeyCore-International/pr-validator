// What symbols does this repository already have?
//
// The duplication check is the only one that needs to look beyond the diff: to
// say "this replicates something that already exists" you have to know what
// already exists. So this builds a whole-repository index, reusing the same
// regex extractors the tests check uses on diff lines.
//
// Every scope is indexed — exported, module-private, class members, the inner
// helpers of a composable. A copy is a copy whoever can call it, and the
// commonest one is a private formatter pasted from one file into the next. Each
// symbol carries its `scope`, its `container` and its `span`, the lines it
// occupies, which is what lets the duplication check ask which functions a pull
// request actually reached.
//
// In CI the index is built on every run and thrown away. No cache.
//
// Caching it would mean storage, and storage is exactly what already cost this
// organisation a night of red checks when the Actions quota ran out. Rebuilding
// costs seconds of runner CPU; depending on storage costs a check going red for
// a reason that has nothing to do with the code. A local run, which re-runs on
// the same checkout many times, can opt in with `cacheDir`.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRegularFileWithin } from './files.mjs';
import { extractorFor, withDefaults } from '../symbols/index.mjs';
import { bodyEnd, maskSource } from '../symbols/scan.mjs';

/** Ceiling on files read. Past this the index is declared partial, never silently short. */
const MAX_INDEXED_FILES = 4000;

/** Ceiling per file. Anything larger is generated or vendored in practice. */
const MAX_FILE_CHARS = 400_000;
/**
 * Ceiling on indexed symbols, not just on files.
 *
 * The file cap does not bound this: a branch of minimal declarations stays far
 * under 4000 files and still produces well over a million entries, and the pair
 * loop walks the whole index once per symbol the pull request introduces.
 */
const MAX_INDEXED_SYMBOLS = 120_000;

/** How many lines of a symbol's body to keep as its fingerprint source. */
const MAX_BODY_LINES = 40;

/**
 * How many characters of it, alongside the line count.
 *
 * A line budget bounds nothing on its own: one line can be as long as the file
 * it sits in, and everything that reads a body afterwards pays for its size.
 * This works out at 400 characters a line across the whole window — several
 * times the widest code anybody writes — so a body a person wrote arrives
 * whole and scores exactly as it did before.
 */
const MAX_BODY_CHARS = 16_000;

/**
 * Bumped whenever what the extractors produce changes shape, so a cache written
 * by an older version is ignored rather than trusted.
 */
const CACHE_VERSION = 2;
const CACHE_FILE = 'symbol-index.json';

/**
 * How far above a declaration an inline ignore may sit: the comment itself plus
 * the attributes, decorators and doc lines between it and the declaration.
 */
const MAX_IGNORE_LOOKBACK = 6;

/** `pr-validator-ignore duplication: <reason>` in any comment syntax. */
const IGNORE = /pr-validator-ignore\s+duplication\b(?:\s*:\s*(.*))?/;

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Every tracked file in a language we can read. */
export function indexableFiles(repo = '.') {
  let listing;
  try {
    listing = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard']);
  } catch {
    return [];
  }

  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => extractorFor(path) !== null);
}

/**
 * Lines `start..end` of a file, within the line and character budgets.
 *
 * The window closes on whichever budget runs out first; a line that does not
 * fit the characters left is cut, not dropped.
 */
function clip(lines, start, end, maxLines, maxChars) {
  const collected = [];
  let used = 0;

  for (let i = start; i <= end && i < lines.length && collected.length < maxLines && used < maxChars; i += 1) {
    const room = maxChars - used;
    const whole = lines[i];
    const line = whole.length > room ? whole.slice(0, room) : whole;
    collected.push(line);
    used += line.length;
  }

  return collected;
}

/**
 * The lines belonging to a symbol declared at `startIndex`.
 *
 * The end of a declaration is found by `bodyEnd` in `src/symbols/scan.mjs`,
 * over a copy of the lines with strings, comments and regex literals masked
 * out, so a brace inside a string no longer moves it. Three shapes:
 *
 *  - a body in braces ends where its brackets close. The `{` may sit on the
 *    next line (C#'s dominant style) or after a parameter list wrapped across
 *    several;
 *  - an arrow at depth 0 ends where its brackets close and the next line does
 *    not carry the expression on with a `.` or an operator. Code written without
 *    semicolons used to run on into whatever was declared next;
 *  - no body at all — an interface member, an abstract method, a field — ends
 *    at its `;` or at a blank line.
 *
 * The window closes on whichever budget runs out first, lines or characters.
 */
export function bodyLines(lines, startIndex, maxLines = MAX_BODY_LINES, maxChars = MAX_BODY_CHARS) {
  // Only the window can be returned, so only the window is scanned. A declaration
  // line is code, so masking can start on it with no state carried in.
  const window = lines.slice(startIndex, startIndex + maxLines).map((line) => line.slice(0, maxChars));
  const masked = maskSource(window, { regex: true, verbatim: true });
  const end = startIndex + bodyEnd(masked, 0, { raw: window });

  return clip(lines, startIndex, end, maxLines, maxChars);
}

/**
 * An inline ignore attached to the declaration on line `index`.
 *
 * Read on the declaration line itself, or on the lines just above it as long as
 * they are comments, attributes or decorators. The reason is mandatory: an
 * ignore without one is reported as invalid and ignores nothing, because "why
 * this copy is fine" is the only part a reviewer can check later.
 *
 * `line` is the 1-based line that carries the comment, so a caller can tell an
 * ignore the base branch already had from one the change under review added.
 *
 * @returns {{reason: string, line: number}|{invalid: true, line: number}|null}
 */
export function inlineIgnore(lines, index) {
  for (let i = index; i >= 0 && index - i <= MAX_IGNORE_LOOKBACK; i -= 1) {
    const text = String(lines[i] ?? '');

    if (i < index) {
      const trimmed = text.trim();
      const annotation = /^(?:\/\/|\/\*|\*|#|<!--|\[|@)/.test(trimmed);
      if (!annotation) break;
    }

    const match = text.match(IGNORE);
    if (!match) continue;

    const reason = String(match[1] ?? '')
      .replace(/\s*(?:\*\/|-->)\s*$/, '')
      .trim();
    return reason ? { reason: reason.slice(0, 300), line: i + 1 } : { invalid: true, line: i + 1 };
  }

  return null;
}

function readCache(cacheDir) {
  if (!cacheDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(cacheDir, CACHE_FILE), 'utf8'));
    if (parsed?.version !== CACHE_VERSION || typeof parsed.files !== 'object' || !parsed.files) return {};
    return parsed.files;
  } catch {
    return {};
  }
}

function writeCache(cacheDir, files) {
  if (!cacheDir) return;
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, CACHE_FILE), JSON.stringify({ version: CACHE_VERSION, files }));
  } catch {
    // A cache that cannot be written costs the next run its head start, nothing
    // else. The index it would have held is already in memory.
  }
}

/** Every symbol in one file, with its body, span and inline ignore. */
function symbolsOfFile(path, content) {
  const extractor = extractorFor(path);
  const rawLines = content.split('\n');
  const numbered = rawLines.map((text, index) => ({ line: index + 1, text }));
  const out = [];

  for (const extracted of extractor(numbered, path)) {
    const symbol = withDefaults(extracted, path);
    const start = symbol.line - 1;
    const end = Math.max(start, Number(symbol.span[1]) - 1);

    const entry = {
      ...symbol,
      body: clip(rawLines, start, end, MAX_BODY_LINES, MAX_BODY_CHARS).join('\n'),
    };

    const ignore = inlineIgnore(rawLines, start);
    if (ignore) entry.ignore = ignore;

    out.push(entry);
  }

  return out;
}

/**
 * Build the repository's symbol index.
 *
 * @param {object} opts
 * @param {string} [opts.repo]
 * @param {(path: string) => boolean} [opts.exclude] paths to leave out
 * @param {string|null} [opts.cacheDir] where to keep per-file results between
 *   runs, keyed by content hash; null (the default, and what CI uses) keeps none
 * @param {number|null} [opts.deadline] epoch milliseconds past which no further
 *   file is read; the index is then declared truncated and `timedOut`
 * @returns {{
 *   symbols: Array<{name, kind, line, signature, exported, scope, container, span, path, body: string}>,
 *   fileCount: number,
 *   skippedFiles: number,
 *   truncated: boolean,
 *   timedOut: boolean
 * }}
 */
export function buildSymbolIndex({ repo = '.', exclude = () => false, cacheDir = null, deadline = null } = {}) {
  const all = indexableFiles(repo);
  const files = all.filter((path) => !exclude(path));
  const truncated = files.length > MAX_INDEXED_FILES;
  const selected = truncated ? files.slice(0, MAX_INDEXED_FILES) : files;

  const cached = readCache(cacheDir);
  const nextCache = cacheDir ? {} : null;

  const symbols = [];
  let read = 0;
  // Listed by git, left out of the index: the ceiling above, plus whatever the
  // read guard refuses below.
  let skipped = all.length - selected.length;
  let symbolsTruncated = false;

  let timedOut = false;

  for (const path of selected) {
    // The caller's wall-clock budget covers reading the repository too: near the
    // symbol ceiling, reading alone took longer than the whole budget.
    if (deadline !== null && Date.now() >= deadline) {
      timedOut = true;
      break;
    }

    const full = join(repo, path);

    // `git ls-files` lists a symlink like any other file, and this index feeds
    // a prompt: a link to `.git/config` would be quoted into it. Refusing one
    // only makes the index smaller, which can cost a duplication candidate but
    // can never invent one.
    if (!isRegularFileWithin(full, repo)) {
      skipped += 1;
      continue;
    }

    // Size checked before reading, not after. Reading first and discarding meant
    // a 400 MB file was pulled into memory in full just to be dropped, so the
    // ceiling protected the loop but not the runner.
    try {
      if (statSync(full).size > MAX_FILE_CHARS) {
        skipped += 1;
        continue;
      }
    } catch {
      skipped += 1;
      continue;
    }

    let content;
    try {
      content = readFileSync(full, 'utf8');
    } catch {
      // Listed by git but unreadable here: a submodule, a permission, a file
      // already gone from the working tree. Not part of the index.
      continue;
    }

    if (content.length > MAX_FILE_CHARS) continue;
    read += 1;

    let fileSymbols;
    if (cached) {
      const hash = createHash('sha256').update(content).digest('hex');
      const hit = cached[path];
      fileSymbols = hit && hit.hash === hash && Array.isArray(hit.symbols) ? hit.symbols : symbolsOfFile(path, content);
      nextCache[path] = { hash, symbols: fileSymbols };
    } else {
      fileSymbols = symbolsOfFile(path, content);
    }

    for (const symbol of fileSymbols) symbols.push(symbol);

    // A ceiling on symbols, not only on files. The file cap does not bound this:
    // 100 files of minimal declarations sit far under it and still yield well over
    // a million entries, and the scoring pass walks the whole index once per
    // symbol the pull request introduces.
    if (symbols.length >= MAX_INDEXED_SYMBOLS) {
      symbolsTruncated = true;
      break;
    }
  }

  writeCache(cacheDir, nextCache);

  return {
    symbols,
    fileCount: read,
    skippedFiles: skipped,
    truncated: truncated || symbolsTruncated || timedOut,
    timedOut,
  };
}
