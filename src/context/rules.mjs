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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DEFAULT_RULES_DIR = join('.claude', 'rules');
export const DEFAULT_MAX_RULES_CHARS = 48000;

const RULE_FILE_PATTERN = /\.(md|mdc|txt)$/i;

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

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Every rule file that exists, with the label it will carry in the prompt. */
function discover(repo, rulesDir) {
  const found = [];
  const seen = new Set();

  const sources = rulesDir
    ? [{ kind: 'dir', path: rulesDir, origin: 'reglas del proyecto', absolute: true }]
    : RULE_SOURCES;

  for (const source of sources) {
    const base = source.absolute ? source.path : join(repo, source.path);

    if (source.kind === 'dir') {
      for (const file of walk(base)) {
        if (seen.has(file)) continue;
        seen.add(file);
        found.push({
          file,
          // Labelled relative to its own source folder, so the model sees
          // `naming.md` rather than a path that means nothing to it.
          label: relative(base, file).split(sep).join('/'),
          origin: source.origin,
        });
      }
      continue;
    }

    if (!isFile(base) || seen.has(base)) continue;
    seen.add(base);
    found.push({ file: base, label: source.path, origin: source.origin });
  }

  return found;
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
 *   empty: boolean
 * }}
 */
export function loadRules({
  repo = '.',
  rulesDir,
  maxChars = DEFAULT_MAX_RULES_CHARS,
  touched = null,
} = {}) {
  const discovered = discover(repo, rulesDir);

  const sources = [];
  const omittedSources = [];
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
    omittedSources,
    empty: parts.length === 0,
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

  const scoped = rules.omittedSources.filter((s) => s.reason !== 'presupuesto');
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

/** Does any touched path match any of these globs? */
export function matchesAny(globs, paths) {
  const patterns = globs.map(globToRegExp);
  return paths.some((path) => patterns.some((pattern) => pattern.test(path)));
}

/** The small glob subset these files actually use: `*`, `**`, `?`, `{a,b}`. */
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

  return new RegExp(`^${out}$`, 'i');
}
