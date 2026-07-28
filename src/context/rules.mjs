// Project rules context: the conventions a repository wrote down about itself.
//
// Phase 1 discovers `.claude/rules/**` and loads everything, matching the
// previous behaviour. Two things change vs the original: the budget is raised,
// and truncation is measured instead of silent.
//
// The real fix is the relevance pre-filter (F2.5) — measured on a real repo,
// the rules corpus was 38k chars against a 24k budget, so a third of the rules
// were being dropped without anyone knowing. Until that lands, the loader at
// least reports what it had to cut.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DEFAULT_RULES_DIR = join('.claude', 'rules');
export const DEFAULT_MAX_RULES_CHARS = 48000;

const RULE_FILE_PATTERN = /\.(md|mdc|txt)$/i;

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

/**
 * Load the repository's written rules.
 *
 * @param {object} [opts]
 * @param {string} [opts.repo='.']
 * @param {string} [opts.rulesDir]  Defaults to `<repo>/.claude/rules`.
 * @param {number} [opts.maxChars]
 * @returns {{
 *   dir: string,
 *   sources: Array<{path: string, chars: number}>,
 *   text: string,
 *   totalChars: number,
 *   truncated: boolean,
 *   omittedSources: Array<{path: string, chars: number}>,
 *   empty: boolean
 * }}
 */
export function loadRules({ repo = '.', rulesDir, maxChars = DEFAULT_MAX_RULES_CHARS } = {}) {
  const dir = rulesDir || join(repo, DEFAULT_RULES_DIR);
  const files = walk(dir);

  const sources = [];
  const omittedSources = [];
  const parts = [];
  let used = 0;
  let truncated = false;
  let totalChars = 0;

  for (const file of files) {
    const body = readFileSync(file, 'utf8').trim();
    const label = relative(dir, file).split(sep).join('/');
    const section = `### ${label}\n${body}`;
    totalChars += section.length;

    // Whole-file granularity: half a rule file is worse than none, because a
    // model will happily judge against a convention it only half read.
    if (used + section.length > maxChars) {
      truncated = true;
      omittedSources.push({ path: label, chars: section.length });
      continue;
    }

    parts.push(section);
    sources.push({ path: label, chars: section.length });
    used += section.length + 2;
  }

  return {
    dir,
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
  const omitted = rules.omittedSources.map((s) => s.path).join(', ');
  return (
    `Corpus de reglas truncado: ${rules.sources.length} de ` +
    `${rules.sources.length + rules.omittedSources.length} archivos cargados ` +
    `(${rules.totalChars} caracteres en total). Omitidos por presupuesto: ${omitted}.`
  );
}
