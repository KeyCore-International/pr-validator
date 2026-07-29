// Which checks does this run execute?
//
// Runs in its own tiny job before the matrix fans out, and it exists so the
// list of valid check names comes from the registry rather than from a string
// duplicated into YAML. A name list that lives in two places is a name list
// that will disagree with itself the first time somebody adds a check.
//
// Precedence, highest first:
//   1. the `checks` input of the reusable workflow
//   2. `checks` in the consuming repository's `.pr-validator.json`
//   3. every implemented check
//
// A misspelt name never blocks a merge. It is a configuration problem in the
// consuming repository, not a problem with the code under review, and this gate
// does not hold a team hostage over either.

import { writeFileSync } from 'node:fs';
import { listChecks, mandatoryChecks, sortChecks } from './checks/registry.mjs';
import { loadRepoConfig, requestedChecks } from './context/repo-config.mjs';

function parseList(value) {
  const names = String(value || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length ? names : null;
}

/**
 * @param {object} opts
 * @param {string} [opts.input]    The workflow's `checks` input.
 * @param {string} [opts.repo]
 * @param {string} [opts.configPath]
 * @returns {{checks: string[], source: string, warnings: string[]}}
 */
export function resolveChecks({ input = '', repo = '.', configPath } = {}) {
  const available = listChecks();
  const warnings = [];

  const fromInput = parseList(input);
  let requested = fromInput;
  let source = 'input del workflow';
  // The workflow input comes from the consuming repository's own workflow file on
  // the base branch, so it is allowed to narrow the run. The config file is read
  // from the head checkout — the branch under review — and is not.
  let fromHead = false;

  if (!requested) {
    const loaded = loadRepoConfig({ repo, configPath });
    warnings.push(...loaded.notes);
    requested = requestedChecks(loaded.config);
    if (requested) {
      source = `\`${configPath || '.pr-validator.json'}\``;
      fromHead = true;
    }
  }

  if (!requested) {
    return { checks: available, source: 'todos los checks implementados', warnings };
  }

  const unique = [...new Set(requested)];
  const known = unique.filter((name) => available.includes(name));
  const unknown = unique.filter((name) => !available.includes(name));

  if (unknown.length) {
    warnings.push(
      `Checks desconocidos en ${source}: ${unknown.join(', ')}. ` +
        `Disponibles: ${available.join(', ')}.`,
    );
  }

  // Every name was wrong. Running nothing would leave the pull request
  // unreviewed while every status check stayed green — a gate that protects
  // nothing and says nothing. Falling back keeps the protection and the warning
  // above says exactly what to fix.
  if (!known.length) {
    warnings.push('Ningún nombre válido en la lista configurada; se ejecutan todos los checks.');
    return { checks: available, source: 'todos los checks implementados', warnings };
  }

  // A head-side list may add checks; it may not take one away. Anything the
  // validator ships as blocking is put back, and the addition is declared so the
  // branch is not left wondering why its list was not obeyed.
  if (fromHead) {
    const floor = mandatoryChecks().filter((name) => !known.includes(name));
    if (floor.length) {
      warnings.push(
        `${source} omite checks bloqueantes (${floor.join(', ')}): se ejecutan de todos modos. ` +
          'La lista de un archivo en la rama del PR puede añadir checks, nunca quitarlos.',
      );
      return { checks: sortChecks([...known, ...floor]), source, warnings };
    }
  }

  return { checks: sortChecks(known), source, warnings };
}

/** Append a `key=value` pair to the GitHub Actions output file, when present. */
function setOutput(key, value, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  writeFileSync(file, `${key}=${value}\n`, { flag: 'a' });
}

export function main(env = process.env) {
  const resolved = resolveChecks({
    input: env.INPUT_CHECKS || '',
    repo: env.INPUT_REPO || '.',
    configPath: env.INPUT_CONFIG_PATH || '',
  });

  for (const warning of resolved.warnings) console.error(`::warning::${warning}`);

  setOutput('matrix', JSON.stringify(resolved.checks), env);
  setOutput('count', String(resolved.checks.length), env);
  console.error(`Checks (${resolved.source}): ${resolved.checks.join(', ')}`);

  // Always 0: a configuration problem in the consuming repository warns, it
  // does not stop the run.
  return 0;
}
