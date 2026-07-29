// What public symbols does this repository already have?
//
// The duplication check is the only one that needs to look beyond the diff: to
// say "this replicates something that already exists" you have to know what
// already exists. So this builds a whole-repository index of public symbols,
// reusing the same regex extractors the tests check uses on diff lines.
//
// The index is built on every run and thrown away. No cache.
//
// Caching it would mean storage, and storage is exactly what already cost this
// organisation a night of red checks when the Actions quota ran out. Rebuilding
// costs seconds of runner CPU; depending on storage costs a check going red for
// a reason that has nothing to do with the code.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRegularFileWithin } from './files.mjs';
import { extractorFor } from '../symbols/index.mjs';

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
 * The lines belonging to a symbol declared at `startIndex`.
 *
 * Brace counting, which all four supported languages share. Braces inside
 * strings and comments are counted too — the window ends up slightly long or
 * slightly short, and since this feeds a similarity SIGNAL rather than a
 * verdict, the cost of that is a candidate ranked a little off, never a false
 * finding.
 *
 * The window closes on whichever budget runs out first, lines or characters.
 */
export function bodyLines(lines, startIndex, maxLines = MAX_BODY_LINES, maxChars = MAX_BODY_CHARS) {
  const collected = [];
  let depth = 0;
  let opened = false;
  let used = 0;

  for (let i = startIndex; i < lines.length && collected.length < maxLines && used < maxChars; i += 1) {
    const room = maxChars - used;
    const whole = lines[i];
    const line = whole.length > room ? whole.slice(0, room) : whole;
    collected.push(line);
    used += line.length;

    for (const char of line) {
      if (char === '{') {
        depth += 1;
        opened = true;
      } else if (char === '}') {
        depth -= 1;
      }
    }

    if (opened) {
      if (depth <= 0) break;
      continue;
    }

    // No body has opened yet, and that is not the same as there being none.
    // C#'s dominant brace style puts the `{` on its own next line, and a
    // multi-line parameter list pushes it further still — giving up at the
    // declaration line would leave every Allman-style method with an empty
    // body and no signal to compare.
    //
    // What does mean there is no body: a line that terminates a statement (an
    // interface member, an abstract method, a field, a one-line arrow) or a
    // blank one.
    const trimmed = line.trim();
    if (trimmed.endsWith(';') || trimmed === '') break;
  }

  return collected;
}

/**
 * Build the repository's public-symbol index.
 *
 * @param {object} opts
 * @param {string} [opts.repo]
 * @param {(path: string) => boolean} [opts.exclude] paths to leave out
 * @returns {{
 *   symbols: Array<{name, kind, line, signature, exported, path, body: string}>,
 *   fileCount: number,
 *   skippedFiles: number,
 *   truncated: boolean
 * }}
 */
export function buildSymbolIndex({ repo = '.', exclude = () => false } = {}) {
  const all = indexableFiles(repo);
  const files = all.filter((path) => !exclude(path));
  const truncated = files.length > MAX_INDEXED_FILES;
  const selected = truncated ? files.slice(0, MAX_INDEXED_FILES) : files;

  const symbols = [];
  let read = 0;
  // Listed by git, left out of the index: the ceiling above, plus whatever the
  // read guard refuses below.
  let skipped = all.length - selected.length;
  let symbolsTruncated = false;

  for (const path of selected) {
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

    const extractor = extractorFor(path);
    const rawLines = content.split('\n');
    const numbered = rawLines.map((text, index) => ({ line: index + 1, text }));

    for (const symbol of extractor(numbered, path)) {
      if (!symbol.exported) continue;
      symbols.push({
        ...symbol,
        path,
        body: bodyLines(rawLines, symbol.line - 1).join('\n'),
      });
    }

    // A ceiling on symbols, not only on files. The file cap does not bound this:
    // 100 files of minimal declarations sit far under it and still yield well over
    // a million entries, and the scoring pass walks the whole index once per
    // symbol the pull request introduces.
    if (symbols.length >= MAX_INDEXED_SYMBOLS) {
      symbolsTruncated = true;
      break;
    }
  }

  return {
    symbols,
    fileCount: read,
    skippedFiles: skipped,
    truncated: truncated || symbolsTruncated,
  };
}
