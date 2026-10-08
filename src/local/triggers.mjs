// Triggers: deterministic signals that a change deserves more review.
//
// The engine knows no stack. Each caller passes its own list — path globs,
// added-line patterns, commit-subject patterns — and lists from several files
// are merged by adding patterns, never by replacing them. A repository can make
// a trigger fire more often; nothing here lets it fire less.
//
// Accepted file shapes (JSON):
//
//   { "triggers": { "AUTH": { "paths": [...], "added": [...] } } }
//   { "AUTH": { "paths": [...] }, "WRITE": { ... } }
//   [ { "id": "AUTH", "paths": [...] } ]
//
// Fields of one trigger, every one optional:
//
//   paths     globs over changed files
//   newPaths  globs over files the change ADDS
//   added     regexes over added lines; "/body/flags" or a bare body. An item
//             may also be { "pattern": "/…/", "in": ["glob", …] }: that pattern
//             reads only the files its own `in` names, whatever `addedIn` says
//   addedIn   globs restricting which files the plain `added` strings read
//   commits   regexes over the subjects of the range's commits
//   branches  regexes over the name of the branch under review
//   scope     "prod" (default: production files only) or "all"
//
// A file matched by several `paths` (or `newPaths`) globs of one trigger is one
// hit, not one per glob: overlapping globs (`**/composables/use*` and
// `**/composables/**/use*`) must not count the same file twice.
//
// The scoped `added` item is how a trigger weighs what changed rather than
// where: "a token, guard or permission line inside an auth folder" instead of
// "any file in an auth folder". A path glob alone fired AUTH for a reducer
// action and a terms-of-service message, and pushed a small change to the
// largest review tier.

import { matchesAny } from '../context/rules.mjs';
import { addedLinesByFile } from '../symbols/index.mjs';

/** Raised for a triggers file that cannot be used; the CLI maps it to a usage error. */
export class TriggerSpecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TriggerSpecError';
  }
}

/**
 * Triggers that always exist.
 *
 * FIX marks an incident fix: a `fix/` or `hotfix/` branch, or the caller's flag
 * (`--fix`, raised for an incident). A commit subject does not raise it:
 * `fix(scope):` is also how a feature branch records the corrections of its own
 * review, and reading it as an incident sent ordinary features down the
 * incident path.
 */
export const BUILTIN_TRIGGERS = {
  FIX: { branches: ['/^(?:hotfix|fix)\\//i'] },
};

/** Hits kept per trigger. The rest are counted, not listed. */
const MAX_HITS = 20;

const LIST_FIELDS = ['paths', 'newPaths', 'added', 'addedIn', 'commits', 'branches'];

/** Fields whose items are regular expressions, validated when merged. */
const PATTERN_FIELDS = new Set(['added', 'commits', 'branches']);

/**
 * One `added` item, normalised: a string stays a string; a scoped item becomes
 * `{pattern, in}` with its globs sorted, so two files declaring the same item
 * merge into one.
 */
function normaliseAdded(id, item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const globs = item.in;
    if (typeof item.pattern !== 'string' || !Array.isArray(globs) || !globs.length) {
      throw new TriggerSpecError(`trigger ${id}.added: a scoped item needs "pattern" and a non-empty "in" list`);
    }
    return { pattern: item.pattern, in: [...new Set(globs.map(String))].sort() };
  }
  return String(item);
}

/** The text an `added` item is deduplicated and reported by. */
function addedKey(item) {
  return typeof item === 'string' ? item : `${item.pattern} in ${item.in.join(',')}`;
}

/** Compile "/body/flags" or a bare body into a RegExp. */
export function compilePattern(source) {
  const text = String(source ?? '');
  const literal = text.match(/^\/(.+)\/([a-z]*)$/s);
  try {
    return literal ? new RegExp(literal[1], literal[2].replace(/g/g, '')) : new RegExp(text);
  } catch (err) {
    throw new TriggerSpecError(`invalid trigger pattern ${JSON.stringify(text)}: ${err.message}`);
  }
}

function asEntries(spec) {
  if (Array.isArray(spec)) {
    return spec.map((item) => {
      if (!item || typeof item !== 'object' || !item.id) {
        throw new TriggerSpecError('every trigger in a list needs an "id"');
      }
      return [String(item.id), item];
    });
  }
  if (spec && typeof spec === 'object') {
    const map = spec.triggers && typeof spec.triggers === 'object' ? spec.triggers : spec;
    return Array.isArray(map) ? asEntries(map) : Object.entries(map);
  }
  throw new TriggerSpecError('a triggers file must hold an object or an array');
}

/**
 * Merge trigger specs, adding patterns per id.
 *
 * @param {Array<object>} specs  Parsed triggers files, in any accepted shape.
 * @returns {Record<string, {paths: string[], newPaths: string[],
 *   added: Array<string|{pattern: string, in: string[]}>,
 *   addedIn: string[], commits: string[], branches: string[], scope: string}>}
 */
export function mergeTriggerSpecs(specs = []) {
  const out = {};
  for (const spec of [BUILTIN_TRIGGERS, ...specs]) {
    for (const [id, raw] of asEntries(spec)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(id)) {
        throw new TriggerSpecError(`trigger id "${id}" must be UPPER_SNAKE_CASE`);
      }
      const target = (out[id] ??= {
        paths: [],
        newPaths: [],
        added: [],
        addedIn: [],
        commits: [],
        branches: [],
        scope: 'prod',
      });
      for (const field of LIST_FIELDS) {
        const value = raw?.[field];
        if (value === undefined) continue;
        if (!Array.isArray(value)) {
          throw new TriggerSpecError(`trigger ${id}.${field} must be an array`);
        }
        for (const item of value) {
          if (field === 'added') {
            const added = normaliseAdded(id, item);
            compilePattern(typeof added === 'string' ? added : added.pattern);
            const key = addedKey(added);
            if (!target.added.some((existing) => addedKey(existing) === key)) target.added.push(added);
            continue;
          }
          const text = String(item);
          if (PATTERN_FIELDS.has(field)) compilePattern(text);
          if (!target[field].includes(text)) target[field].push(text);
        }
      }
      // Widening only: once any source asks for every file, the trigger reads
      // every file.
      if (raw?.scope === 'all') target.scope = 'all';
    }
  }
  return out;
}

function globHit(globs, path) {
  return globs.some((glob) => matchesAny([glob], [path]));
}

function byLocation(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
  return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
}

/**
 * Evaluate every trigger against a change.
 *
 * @param {object} opts
 * @param {object} opts.specs     `mergeTriggerSpecs()` output.
 * @param {Array<{path: string, status: string, category: string}>} opts.files
 * @param {string} opts.diffText  Unified diff of the same range.
 * @param {Array<{sha: string, subject: string}>} [opts.commits]
 * @param {string} [opts.branch]  Name of the branch under review; '' when unknown (detached).
 * @param {string[]} [opts.flags] Trigger ids raised by the caller (an incident flag).
 * @returns {{ids: string[], hits: Record<string, {count: number, hits: Array<object>}>}}
 */
export function evaluateTriggers({ specs, files, diffText, commits = [], branch = '', flags = [] }) {
  const added = addedLinesByFile(diffText);
  const result = {};

  for (const id of Object.keys(specs).sort()) {
    const spec = specs[id];
    const eligible = files.filter((file) => spec.scope === 'all' || file.category === 'prod');
    const hits = [];

    for (const file of eligible) {
      // One hit per file and field: the first glob that matches it.
      const pathGlob = spec.paths.find((glob) => globHit([glob], file.path));
      if (pathGlob) hits.push({ kind: 'path', path: file.path, pattern: pathGlob });
      if (file.status === 'A') {
        const newGlob = spec.newPaths.find((glob) => globHit([glob], file.path));
        if (newGlob) hits.push({ kind: 'new', path: file.path, pattern: newGlob });
      }
      const plainApplies = !spec.addedIn.length || globHit(spec.addedIn, file.path);
      const patterns = spec.added
        .filter((item) => (typeof item === 'string' ? plainApplies : globHit(item.in, file.path)))
        .map((item) => [addedKey(item), compilePattern(typeof item === 'string' ? item : item.pattern)]);
      if (patterns.length) {
        for (const { line, text } of added.get(file.path) ?? []) {
          for (const [source, pattern] of patterns) {
            if (pattern.test(text)) hits.push({ kind: 'added', path: file.path, line, pattern: source });
          }
        }
      }
    }

    const commitPatterns = spec.commits.map((source) => [source, compilePattern(source)]);
    for (const commit of commits) {
      for (const [source, pattern] of commitPatterns) {
        if (pattern.test(commit.subject)) {
          hits.push({ kind: 'commit', path: commit.sha, pattern: source });
        }
      }
    }

    if (branch) {
      const branchPattern = spec.branches.find((source) => compilePattern(source).test(branch));
      if (branchPattern) hits.push({ kind: 'branch', path: branch, pattern: branchPattern });
    }

    if (flags.includes(id)) hits.push({ kind: 'flag', path: '', pattern: id });

    if (hits.length) {
      hits.sort(byLocation);
      result[id] = { count: hits.length, hits: hits.slice(0, MAX_HITS) };
    }
  }

  // A flag for a trigger no file declares still counts: the caller said so.
  for (const id of flags) {
    if (!result[id] && /^[A-Z][A-Z0-9_]*$/.test(id)) {
      result[id] = { count: 1, hits: [{ kind: 'flag', path: '', pattern: id }] };
    }
  }

  return { ids: Object.keys(result).sort(), hits: result };
}
