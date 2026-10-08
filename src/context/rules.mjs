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

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
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
  // The tool-neutral folder some repositories keep instead of, or beside, the
  // one above. Often a mirror of it: a file reached twice is read once (see
  // `discover`).
  { kind: 'dir', path: join('.agents', 'rules'), origin: 'reglas del proyecto' },
  { kind: 'dir', path: join('.cursor', 'rules'), origin: 'reglas del editor' },
  { kind: 'file', path: '.cursorrules', origin: 'reglas del editor' },
  { kind: 'file', path: '.github/copilot-instructions.md', origin: 'instrucciones del asistente' },
  // The CLAUDE.md / AGENTS.md closest to the touched files when they live in a
  // nested folder: a sub-project's own instructions say more about its code
  // than the ones at the root, so they come before them.
  { kind: 'nearest', names: ['CLAUDE.md', 'AGENTS.md'], origin: 'instrucciones del asistente' },
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
 * The key a discovered file is deduplicated by.
 *
 * A readable file is keyed by its real path: `.agents/rules` is often a link
 * or a junction to `.claude/rules`, and reading the same convention twice
 * spends the budget on a duplicate. A refused one keeps its own path, because
 * a symlink folded into its target would vanish from the refusal report.
 */
function identity(path, readable) {
  if (!readable) return path;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The folders below the root that hold each touched file, deepest first.
 *
 * Paths come from the diff, so anything that is not a plain relative path is
 * skipped rather than resolved: `..` has no business in a diff.
 *
 * @param {string[]|null} touched
 * @returns {string[][]} One ancestor chain per touched file, POSIX, root excluded.
 */
function ancestorChains(touched) {
  const chains = [];
  for (const raw of touched || []) {
    const path = String(raw || '').replace(/\\/g, '/');
    if (!path || path.startsWith('/') || /^[a-z]:/i.test(path)) continue;
    if (path.split('/').includes('..')) continue;

    const chain = [];
    for (let dir = posix.dirname(path); dir !== '.' && dir !== '/'; dir = posix.dirname(dir)) {
      chain.push(dir);
    }
    if (chain.length) chains.push(chain);
  }
  return chains;
}

/**
 * The nearest CLAUDE.md / AGENTS.md above each touched file, below the root.
 *
 * Nearest only, per name: a sub-project's file is written to refine the ones
 * above it, and the root one is loaded on its own anyway. Each folder is
 * probed once however many touched files share it.
 *
 * @returns {string[]} Repo-relative POSIX paths, in first-seen order.
 */
function nearestInstructionFiles(repo, names, touched) {
  const probed = new Map();
  const present = (relPath) => {
    if (!probed.has(relPath)) probed.set(relPath, exists(join(repo, relPath)));
    return probed.get(relPath);
  };

  const out = [];
  for (const chain of ancestorChains(touched)) {
    for (const name of names) {
      const dir = chain.find((candidate) => present(`${candidate}/${name}`));
      if (dir && !out.includes(`${dir}/${name}`)) out.push(`${dir}/${name}`);
    }
  }
  return out;
}

/**
 * The instruction files the budget always serves first: per touched file, the
 * nearest AGENTS.md above it, the root one included; a file with no AGENTS.md
 * anywhere above it pins its nearest CLAUDE.md instead. Without touched files
 * the root is the nearest folder.
 *
 * A repository's AGENTS.md is the one document written for whoever works on its
 * code. Read last in source order, it was the first thing a large rule folder
 * pushed out of the budget, and the review ran against the folder's narrow
 * conventions without the architecture they hang from.
 *
 * @returns {string[]} Repo-relative POSIX paths.
 */
export function pinnedInstructionFiles(repo, touched) {
  const probed = new Map();
  const present = (relPath) => {
    if (!probed.has(relPath)) probed.set(relPath, exists(join(repo, relPath)));
    return probed.get(relPath);
  };
  const at = (dir, name) => (dir === '.' ? name : `${dir}/${name}`);

  const chains = touched ? ancestorChains(touched).map((chain) => [...chain, '.']) : [];
  // A touched file at the root has no chain of its own, and no touched files at
  // all leaves the root as the only folder there is.
  if (!touched || chains.length < touched.length) chains.push(['.']);

  const out = new Set();
  for (const chain of chains) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const dir = chain.find((candidate) => present(at(candidate, name)));
      if (dir) {
        out.add(at(dir, name));
        break;
      }
    }
  }
  return [...out];
}

/**
 * A glob that names an extension or everything, and no folder or file: it
 * claims every file of a kind, so it says nothing about which ones it was
 * written for. `**\/*.cs`, `*.{ts,tsx}`, `**\/{*.cs,appsettings*.json}`.
 */
function isCatchAll(glob) {
  const tail = String(glob).replace(/^(\*\*\/)+/, '');
  return !tail.includes('/') && /^\{?\*/.test(tail);
}

/**
 * Where one rule stands in the budget queue: `tier` first (lower is served
 * first), then `matched` (more is served first).
 *
 *   0  a pinned instruction file (`pinnedInstructionFiles`)
 *   1  declares paths, and they name files this change touches
 *   2  declares paths that match, but only catch-alls such as `**\/*.cs`
 *   3  declares no paths, or the touched files are unknown
 */
function ruleRank({ relPath, scope, touched, pinned }) {
  if (pinned.has(relPath)) return { tier: 0, matched: 0 };
  if (!touched || !scope.length) return { tier: 3, matched: 0 };
  const matched = touched.filter((path) => matchesAny(scope, [path])).length;
  return { tier: scope.every(isCatchAll) ? 2 : 1, matched };
}

/**
 * Every rule file that exists, split into the ones this gate will read and the
 * ones it refuses to.
 *
 * A refused file is NOT dropped here. "Absent" and "present but not readable
 * as a rule" are different pieces of news, and only the first one is silent:
 * the second is a convention the repository wrote and this gate did not apply.
 */
function discover(repo, rulesDir, touched) {
  const found = [];
  const blocked = [];
  const seen = new Set();
  const labels = new Set();

  const sources = rulesDir
    ? [{ kind: 'dir', path: rulesDir, origin: 'reglas del proyecto', absolute: true }]
    : RULE_SOURCES;

  // The tree everything read has to stay inside. In a run it is the checkout;
  // `rulesDir` is the test seam, and it names its own directory.
  const root = rulesDir || repo;

  // A label is what the model and the comment see. Two rule folders can both
  // hold a `naming.md`; the second one is named by its repo-relative path so
  // the two stay distinguishable.
  const uniqueLabel = (preferred, fallback) => {
    const label = labels.has(preferred) ? fallback : preferred;
    labels.add(label);
    return label;
  };

  const addFile = (file, label, origin) => {
    const readable = isRegularFileWithin(file, root);
    if (!readable && !exists(file)) return;

    const key = identity(file, readable);
    if (seen.has(key)) return;
    seen.add(key);
    (readable ? found : blocked).push({ file, label: uniqueLabel(label, label), origin });
  };

  for (const source of sources) {
    if (source.kind === 'nearest') {
      // Without the touched files there is no "nearest" to speak of.
      for (const relPath of nearestInstructionFiles(repo, source.names, touched)) {
        addFile(join(repo, relPath), relPath, source.origin);
      }
      continue;
    }

    const base = source.absolute ? source.path : join(repo, source.path);

    if (source.kind === 'dir') {
      for (const file of walk(base)) {
        const readable = isRegularFileWithin(file, root);
        const key = identity(file, readable);
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = {
          file,
          // Labelled relative to its own source folder, so the model sees
          // `naming.md` rather than a path that means nothing to it.
          label: uniqueLabel(
            relative(base, file).split(sep).join('/'),
            relative(root, file).split(sep).join('/'),
          ),
          origin: source.origin,
        };
        (readable ? found : blocked).push(entry);
      }
      continue;
    }

    addFile(base, source.path, source.origin);
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
/** The rules folder relative to the repository, posix; the default name when it lies outside. */
export function rulesDirLabel(repo, rulesDir) {
  if (!rulesDir) return posix.join('.claude', 'rules');
  const rel = relative(repo, rulesDir);
  if (!rel) return '.';
  if (rel.startsWith('..') || /^[A-Za-z]:|^[\\/]/.test(rel)) return posix.join('.claude', 'rules');
  return rel.split(sep).join('/');
}

export function loadRules({
  repo = '.',
  rulesDir,
  maxChars = DEFAULT_MAX_RULES_CHARS,
  touched = null,
} = {}) {
  const { found: discovered, blocked } = discover(repo, rulesDir, touched);
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

  const pinned = rulesDir ? new Set() : new Set(pinnedInstructionFiles(repo, touched));
  const candidates = [];
  // Omissions keyed by discovery position, so the report reads in the same
  // order whatever the budget order was.
  const omitted = [];

  discovered.forEach((found, index) => {
    let body;
    try {
      body = readFileSync(found.file, 'utf8').trim();
    } catch {
      return; // Vanished between listing and reading. Not an error worth a verdict.
    }

    const scope = declaredScope(body);
    const section = `### ${found.label}\n${stripFrontmatter(body)}`;
    totalChars += section.length;

    // Scope first, budget second: a rule that does not apply should never have
    // taken space from one that does.
    if (touched && scope.length && !matchesAny(scope, touched)) {
      omitted.push({
        index,
        entry: { path: found.label, chars: section.length, reason: `fuera de alcance (declara ${scope.join(', ')})` },
      });
      return;
    }

    const relPath = relative(repo, found.file).split(sep).join('/');
    candidates.push({ index, found, section, rank: ruleRank({ relPath, scope, touched, pinned }) });
  });

  // Budget order: the nearest AGENTS.md first, then the rules whose declared
  // paths name what this change touches (narrow globs before catch-alls, the
  // ones that cover more of the change first), then everything else as found.
  const queue = [...candidates].sort(
    (a, b) => a.rank.tier - b.rank.tier || b.rank.matched - a.rank.matched || a.index - b.index,
  );
  const kept = new Set();
  for (const candidate of queue) {
    // Whole-file granularity: half a rule file is worse than none, because a
    // model will happily judge against a convention it only half read.
    if (used + candidate.section.length > maxChars) {
      truncated = true;
      omitted.push({
        index: candidate.index,
        entry: { path: candidate.found.label, chars: candidate.section.length, reason: 'presupuesto' },
      });
      continue;
    }
    kept.add(candidate.index);
    used += candidate.section.length + 2;
  }

  for (const candidate of candidates) {
    if (!kept.has(candidate.index)) continue;
    parts.push(candidate.section);
    sources.push({ path: candidate.found.label, chars: candidate.section.length, origin: candidate.found.origin });
  }
  omittedSources.push(...omitted.sort((a, b) => a.index - b.index).map((item) => item.entry));

  return {
    dir: rulesDir || join(repo, DEFAULT_RULES_DIR),
    // The folder as the repository names it, for messages: never an absolute
    // checkout path, so two clones of the same commit print the same bytes.
    dirLabel: rulesDirLabel(repo, rulesDir),
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

/**
 * The keys a rule uses to say which files it governs: `paths` (Claude Code),
 * `globs` (Cursor), and the older spellings. Matched one line at a time; the
 * value is everything after the colon, which may be empty when a YAML block
 * list follows.
 */
const SCOPE_KEY = /^\s*(paths|globs|appliesTo|applies_to|files)\s*:(.*)$/i;
const LIST_ITEM = /^\s*-\s*(.*)$/;

/**
 * Globs a rule file declares in its frontmatter, or [] when it declares none.
 *
 * Accepts every shape these files are written in:
 *
 *   paths: "src/*.ts, src/*.tsx"     one quoted, comma-separated string
 *   globs: *.ts, *.vue               the same, unquoted
 *   globs: ["src/*.vue", "src/*.ts"] a YAML flow list
 *   paths:                           a YAML block list
 *     - "src/**"
 *
 * Commas inside `{a,b}` belong to the glob, never to the list.
 */
export function declaredScope(body) {
  const front = String(body || '').match(FRONTMATTER);
  if (!front) return [];

  const lines = front[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const key = lines[i].match(SCOPE_KEY);
    if (!key) continue;

    const inline = stripComment(key[2].trim());
    const globs = inline ? splitInline(inline) : blockList(lines, i + 1);
    // An empty key (Cursor writes `globs:` for a rule that always applies)
    // declares nothing, so a later scope key still gets its say.
    if (globs.length) return globs;
  }
  return [];
}

/** The `- item` lines under a key, up to the next line that is not one. */
function blockList(lines, from) {
  const items = [];
  for (let j = from; j < lines.length; j += 1) {
    const item = lines[j].match(LIST_ITEM);
    if (item) {
      const glob = unquote(stripComment(item[1].trim()));
      if (glob) items.push(glob);
    } else if (lines[j].trim() && !lines[j].trim().startsWith('#')) {
      break;
    }
  }
  return items;
}

/** A trailing YAML comment, outside any quotes. */
function stripComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trim();
    }
  }
  return value;
}

function unquote(value) {
  const match = value.trim().match(/^(['"])([\s\S]*)\1$/);
  return (match ? match[2] : value).trim();
}

/** The value written on the key's own line: a flow list or a scalar. */
function splitInline(value) {
  if (value.startsWith('[') && value.endsWith(']')) {
    // A flow list: YAML quoting decides what an item is.
    return splitTopLevel(value.slice(1, -1), true).map(unquote).filter(Boolean);
  }
  // A scalar, quoted or not, holding one glob or a comma-separated list.
  return splitTopLevel(unquote(value), false)
    .map((glob) => glob.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** Split on commas that sit outside `{…}` and, when asked, outside quotes. */
function splitTopLevel(value, respectQuotes) {
  const parts = [];
  let current = '';
  let braces = 0;
  let quote = null;

  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (respectQuotes && (char === '"' || char === "'")) {
      quote = char;
    } else if (char === '{') {
      braces += 1;
    } else if (char === '}' && braces > 0) {
      braces -= 1;
    } else if (char === ',' && braces === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
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
