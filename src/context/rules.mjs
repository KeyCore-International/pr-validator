// Project rules context: the conventions a repository wrote down about itself.
//
// Repositories do not keep their conventions in one place. Some have
// `.claude/rules/`, some have Cursor rules, most have a CLAUDE.md or an
// AGENTS.md at the root, and nearly all have a CONTRIBUTING.md that nobody has
// read in a year. A gate that only looks in one folder judges against a
// fraction of what the team actually agreed.
//
// Reading more of them makes the budget bite sooner — measured on a real
// repository, `.claude/rules/` alone was 38k characters against a 48k budget —
// so sources are ordered by how specific they are, filtered by any scope they
// declare, and everything dropped is reported with its reason. Truncating in
// silence was the worst failure of the previous generation of this tool.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isRegularFileWithin } from './files.mjs';

export const DEFAULT_RULES_DIR = join('.claude', 'rules');
export const DEFAULT_MAX_RULES_CHARS = 48000;

const RULE_FILE_PATTERN = /\.(md|mdc|txt)$/i;

/**
 * Why a rule file present in the tree was never opened.
 *
 * A rule file is read and handed to an external gateway, so only regular files
 * inside the repository are read — a symlink could name `.git/config` or any
 * other file the runner can reach. The refusal is recorded like any other
 * omission: a corpus that shrinks in silence is the failure this tool exists
 * not to repeat.
 */
const UNREADABLE_REASON = 'no es un archivo regular dentro del repositorio';

/**
 * Where conventions live, most specific first.
 *
 * Order is the budget policy: a folder somebody created *to hold rules* says
 * more about this repository's conventions than a root file that also explains
 * how to run the tests. When the budget bites, the vaguer source is the one
 * that goes.
 */
export const RULE_SOURCES = [
  { kind: 'dir', path: join('.claude', 'rules'), origin: 'reglas del proyecto' },
  { kind: 'dir', path: join('.cursor', 'rules'), origin: 'reglas del editor' },
  { kind: 'file', path: '.cursorrules', origin: 'reglas del editor' },
  { kind: 'file', path: '.github/copilot-instructions.md', origin: 'instrucciones del asistente' },
  { kind: 'file', path: 'CLAUDE.md', origin: 'instrucciones del asistente' },
  { kind: 'file', path: 'AGENTS.md', origin: 'instrucciones del asistente' },
  { kind: 'file', path: 'CONTRIBUTING.md', origin: 'guía de contribución' },
];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // Missing directory is a valid state: the repo has no rules.
  }

  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (RULE_FILE_PATTERN.test(entry.name)) out.push(full);
  }
  return out;
}

/** Is there anything at this path at all? Never follows a link to answer. */
function exists(path) {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) != null;
  } catch {
    return false;
  }
}

/**
 * Every rule file that exists, split into the ones this gate will read and the
 * ones it refuses to.
 *
 * A refused file is NOT dropped here. "Absent" and "present but not readable
 * as a rule" are different pieces of news, and only the first one is silent:
 * the second is a convention the repository wrote and this gate did not apply.
 */
function discover(repo, rulesDir) {
  const found = [];
  const blocked = [];
  const seen = new Set();

  const sources = rulesDir
    ? [{ kind: 'dir', path: rulesDir, origin: 'reglas del proyecto', absolute: true }]
    : RULE_SOURCES;

  // The tree everything read has to stay inside. In a run it is the checkout;
  // `rulesDir` is the test seam, and it names its own directory.
  const root = rulesDir || repo;

  for (const source of sources) {
    const base = source.absolute ? source.path : join(repo, source.path);

    if (source.kind === 'dir') {
      for (const file of walk(base)) {
        if (seen.has(file)) continue;
        seen.add(file);
        const entry = {
          file,
          // Labelled relative to its own source folder, so the model sees
          // `naming.md` rather than a path that means nothing to it.
          label: relative(base, file).split(sep).join('/'),
          origin: source.origin,
        };
        (isRegularFileWithin(file, root) ? found : blocked).push(entry);
      }
      continue;
    }

    if (seen.has(base)) continue;

    if (isRegularFileWithin(base, root)) {
      seen.add(base);
      found.push({ file: base, label: source.path, origin: source.origin });
    } else if (exists(base)) {
      seen.add(base);
      blocked.push({ file: base, label: source.path, origin: source.origin });
    }
  }

  return { found, blocked };
}

/**
 * Load the repository's written rules.
 *
 * @param {object} [opts]
 * @param {string} [opts.repo='.']
 * @param {string} [opts.rulesDir]  Overrides discovery; used by tests.
 * @param {number} [opts.maxChars]
 * @param {string[]} [opts.touched] Paths the pull request changes, for scoping.
 * @returns {{
 *   dir: string,
 *   sources: Array<{path: string, chars: number, origin: string}>,
 *   text: string,
 *   totalChars: number,
 *   truncated: boolean,
 *   omittedSources: Array<{path: string, chars: number, reason: string}>,
 *   unreadable: string[],
 *   empty: boolean
 * }}
 */
export function loadRules({
  repo = '.',
  rulesDir,
  maxChars = DEFAULT_MAX_RULES_CHARS,
  touched = null,
} = {}) {
  const { found: discovered, blocked } = discover(repo, rulesDir);
  const unreadable = blocked.map((entry) => entry.label);

  const sources = [];
  // Refused files head the omissions: they were never opened, so they have no
  // size and no declared scope, but the corpus is smaller than the repository
  // looks and that has to reach the comment (AC-79).
  const omittedSources = blocked.map((entry) => ({
    path: entry.label,
    chars: 0,
    reason: UNREADABLE_REASON,
  }));
  const parts = [];
  let used = 0;
  let truncated = false;
  let totalChars = 0;

  for (const found of discovered) {
    let body;
    try {
      body = readFileSync(found.file, 'utf8').trim();
    } catch {
      continue; // Vanished between listing and reading. Not an error worth a verdict.
    }

    const scope = declaredScope(body);
    const section = `### ${found.label}\n${stripFrontmatter(body)}`;
    totalChars += section.length;

    // Scope first, budget second: a rule that does not apply should never have
    // taken space from one that does.
    if (touched && scope.length && !matchesAny(scope, touched)) {
      omittedSources.push({
        path: found.label,
        chars: section.length,
        reason: `fuera de alcance (declara ${scope.join(', ')})`,
      });
      continue;
    }

    // Whole-file granularity: half a rule file is worse than none, because a
    // model will happily judge against a convention it only half read.
    if (used + section.length > maxChars) {
      truncated = true;
      omittedSources.push({ path: found.label, chars: section.length, reason: 'presupuesto' });
      continue;
    }

    parts.push(section);
    sources.push({ path: found.label, chars: section.length, origin: found.origin });
    used += section.length + 2;
  }

  return {
    dir: rulesDir || join(repo, DEFAULT_RULES_DIR),
    sources,
    text: parts.join('\n\n'),
    totalChars,
    truncated,
    // Echoed back so a note can state the number that did the dropping.
    maxChars,
    omittedSources,
    // Rule files the repository declared and this gate refused to read.
    unreadable,
    // Every section there was got dropped for budget. Distinct from `empty`
    // because the fix is different — raise the budget, versus write some rules —
    // and because a check that skips green claiming "sin reglas declaradas"
    // while `CLAUDE.md` sits untouched in the tree is stating something false.
    // The budget is settable from the branch under review, so `maxRulesChars: 1`
    // used to buy a green skip on a blocking check with no warning attached.
    budgetExhausted:
      parts.length === 0 && omittedSources.some((s) => s.reason === 'presupuesto'),
    // `empty` answers exactly one question: did this repository write nothing
    // down? A corpus emptied by the read guard, by scope, or by the budget is
    // the opposite answer — the rules are there, in the tree, and were not
    // applied — so none of those may reach the runner as "sin reglas
    // declaradas". Callers that need "is there anything to send to the model"
    // read `text`.
    empty: parts.length === 0 && unreadable.length === 0 && omittedSources.length === 0,
  };
}

/**
 * Human-readable note about which rule sources were loaded and which were
 * dropped for budget (AC-22, AC-23). Returns null when nothing was dropped.
 */
export function rulesTruncationNote(rules) {
  if (!rules.truncated) return null;
  const omitted = rules.omittedSources
    .filter((s) => s.reason === 'presupuesto')
    .map((s) => s.path)
    .join(', ');
  return (
    `Corpus de reglas truncado: ${rules.sources.length} de ` +
    `${rules.sources.length + rules.omittedSources.length} archivos cargados ` +
    `(${rules.totalChars} caracteres en total). Omitidos por presupuesto: ${omitted}.`
  );
}

/**
 * What was loaded and what was left out, each with its reason (AC-79).
 *
 * Two separate lines rather than one: "read these" and "did not read these"
 * are different pieces of news, and a developer wondering why a convention was
 * not applied needs the second one to be findable.
 *
 * @returns {string[]}
 */
export function rulesSourceNotes(rules) {
  const notes = [];

  if (rules.sources.length) {
    notes.push(
      `Reglas cargadas (${rules.sources.length}): ${rules.sources.map((s) => s.path).join(', ')}.`,
    );
  }

  // Its own line, and not folded into the out-of-scope one: "did not apply to
  // this PR" and "was never opened" send a developer to two different places.
  const unreadable = rules.omittedSources.filter((s) => s.reason === UNREADABLE_REASON);
  if (unreadable.length) {
    notes.push(
      `Reglas no leídas (${unreadable.length}): ${unreadable.map((s) => s.path).join(', ')}. ` +
        'Solo se leen archivos regulares dentro del repositorio: un enlace simbólico podría ' +
        'apuntar a credenciales del runner o a una ruta fuera del checkout.',
    );
  }

  const scoped = rules.omittedSources.filter(
    (s) => s.reason !== 'presupuesto' && s.reason !== UNREADABLE_REASON,
  );
  if (scoped.length) {
    notes.push(
      `Reglas omitidas por no aplicar a los archivos de este PR (${scoped.length}): ` +
        `${scoped.map((s) => `${s.path} — ${s.reason}`).join('; ')}.`,
    );
  }

  return notes;
}

// --- Declared scope -------------------------------------------------------
//
// Only scope a rule DECLARES about itself is honoured. Guessing — dropping a
// file called `frontend.md` because the diff has no `.vue` in it — would
// eventually drop the one rule a pull request violates, and a gate that misses
// what it was asked to catch is worse than a gate that reads too much.

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const SCOPE_KEY = /^\s*(globs|appliesTo|applies_to|files)\s*:\s*(.+)$/im;

/** Globs a rule file declares in its frontmatter, or [] when it declares none. */
export function declaredScope(body) {
  const front = String(body || '').match(FRONTMATTER);
  if (!front) return [];

  const scope = front[1].match(SCOPE_KEY);
  if (!scope) return [];

  return scope[2]
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((glob) => glob.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** Drop the frontmatter block: it is metadata for an editor, not a convention. */
function stripFrontmatter(body) {
  return String(body || '').replace(FRONTMATTER, '').trim();
}

/**
 * Does any touched path match any of these globs?
 *
 * A glob nobody can compile is treated as no declared scope at all, so the rule
 * is kept. That direction is deliberate: reading a convention that did not apply
 * costs budget, whereas dropping one that did applies no rule at all — and the
 * throw this replaces reached the runner's catch-all and turned the whole
 * blocking check into a green "no bloquea", which a four-line file could trigger.
 */
export function matchesAny(globs, paths) {
  const patterns = globs.map(globToRegExp).filter(Boolean);
  if (!patterns.length) return true;
  return paths.some((path) => patterns.some((pattern) => pattern.test(path)));
}

/**
 * The small glob subset these files actually use: `*`, `**`, `?`, `{a,b}`.
 *
 * @returns {RegExp|null} null when the glob does not compile.
 */
function globToRegExp(glob) {
  let out = '';
  let braces = 0;

  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];

    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` also matches zero directories, so `**/*.ts` covers `a.ts`.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '{') {
      braces += 1;
      out += '(?:';
    } else if (char === '}' && braces > 0) {
      braces -= 1;
      out += ')';
    } else if (char === ',' && braces > 0) {
      out += '|';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  // An unclosed `{` is the common typo, and `globs: **/*.{ts,tsx}` written one
  // character short of correct used to emit an unterminated group.
  while (braces > 0) {
    out += ')';
    braces -= 1;
  }

  try {
    return new RegExp(`^${out}$`, 'i');
  } catch {
    return null;
  }
}
