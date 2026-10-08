// `rules`: the repository's written conventions, plus any extra rule packs,
// scoped to the files a change touches.
//
// The repository's corpus is loaded exactly as the `rules` check loads it.
// Each extra directory is loaded the same way and kept apart, because the
// caller ranks the sources — a repository rule outranks a pack rule — and it
// cannot rank what arrives already merged.

import { resolve } from 'node:path';
import { loadRules } from '../context/rules.mjs';
import { checkConfig } from './config.mjs';
import { loadRepoConfig } from '../context/repo-config.mjs';
import { gitRun, resolveSha, topLevel } from './git.mjs';

/** The corpus metadata worth printing; the text goes to a separate file. */
function summary(rules) {
  return {
    sources: rules.sources,
    omittedSources: rules.omittedSources,
    unreadable: rules.unreadable,
    truncated: rules.truncated,
    totalChars: rules.totalChars,
    empty: rules.empty,
    budgetExhausted: Boolean(rules.budgetExhausted),
  };
}

/** Files changed between `base` and HEAD, as the `rules` check would scope them. */
export function touchedSince(repo, base) {
  const baseSha = resolveSha(repo, base);
  const out = gitRun(repo, ['diff', '--name-only', '-z', `${baseSha}...HEAD`]).stdout;
  return out.split('\0').filter(Boolean).sort();
}

/**
 * @param {object} opts
 * @param {string} opts.repo
 * @param {string[]} [opts.extraDirs]
 * @param {string[]|null} [opts.touched]  null means "do not scope".
 * @param {string|null} [opts.base]       Derive `touched` from base...HEAD when `touched` is absent.
 * @param {number|null} [opts.maxChars]   Defaults to the `rules` check's budget.
 * @param {string} [opts.configPath]
 * @returns {{touched: string[]|null, repo: object, extra: Array<object>, text: string}}
 */
export function collectRules({
  repo: repoArg,
  extraDirs = [],
  touched = null,
  base = null,
  maxChars = null,
  configPath,
}) {
  const repo = topLevel(repoArg);
  const scope = touched ?? (base ? touchedSince(repo, base) : null);
  const budget = maxChars ?? checkConfig(loadRepoConfig({ repo, configPath }), 'rules').maxRulesChars;

  const own = loadRules({ repo, maxChars: budget, touched: scope });
  const extra = extraDirs.map((dir) => {
    const rules = loadRules({ repo, rulesDir: resolve(dir), maxChars: budget, touched: scope });
    return { dir, ...summary(rules), text: rules.text };
  });

  const parts = [];
  if (own.text) parts.push(`## Reglas del repositorio\n\n${own.text}`);
  for (const pack of extra) {
    if (pack.text) parts.push(`## Paquete de reglas: ${pack.dir}\n\n${pack.text}`);
  }

  return {
    touched: scope,
    repo: summary(own),
    extra: extra.map(({ text, ...rest }) => rest),
    text: parts.join('\n\n'),
  };
}
