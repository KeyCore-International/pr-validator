// The consuming repository's own settings: `.pr-validator.json`.
//
// Lets a team change model, budgets, thresholds or which checks run without
// touching the validator — and without a fork, which is what teams do instead
// when a shared tool has no knobs.
//
// Everything here is tolerant. A missing file is the normal case. A malformed
// one is a configuration problem in someone else's repository, and this gate's
// standing rule is that a problem outside the code under review reports itself
// and lets the merge proceed. Failing the checks over a stray comma would block
// a team for a reason that has nothing to do with their pull request.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_CONFIG_PATH = '.pr-validator.json';

/** Keys accepted at the top level. Anything else is reported, not obeyed. */
const TOP_LEVEL_KEYS = new Set([
  'checks',
  'model',
  'maxDiffChars',
  'maxRulesChars',
  'checksConfig',
]);

/** Keys accepted inside `checks: { <name>: { … } }`. */
const PER_CHECK_KEYS = new Set([
  'model',
  'blocking',
  'attempts',
  'maxDiffChars',
  'maxRulesChars',
  'failOn',
  'threshold',
  'maxCandidates',
]);

/**
 * Read `.pr-validator.json`, if the repository has one.
 *
 * @param {object} [opts]
 * @param {string} [opts.repo='.']
 * @param {string} [opts.configPath]
 * @returns {{config: object, present: boolean, notes: string[]}}
 */
export function loadRepoConfig({ repo = '.', configPath = DEFAULT_CONFIG_PATH } = {}) {
  const full = join(repo, configPath || DEFAULT_CONFIG_PATH);

  let raw;
  try {
    raw = readFileSync(full, 'utf8');
  } catch {
    return { config: {}, present: false, notes: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      config: {},
      present: true,
      notes: [
        `\`${configPath}\` no es JSON válido (${err.message}). Se ignora y se usan los valores por defecto.`,
      ],
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      config: {},
      present: true,
      notes: [`\`${configPath}\` debe contener un objeto JSON. Se ignora.`],
    };
  }

  return { config: parsed, present: true, notes: unknownKeyNotes(parsed, configPath) };
}

/**
 * Name every key that will have no effect.
 *
 * A typo in a configuration file is otherwise invisible: the repository
 * believes it changed the model, the validator carries on with the default,
 * and nothing anywhere says the two disagree.
 */
function unknownKeyNotes(config, configPath) {
  const unknown = Object.keys(config).filter((key) => !TOP_LEVEL_KEYS.has(key));

  const perCheck = [];
  const checks = config.checks;
  // `checks` is either the list of checks to run or a per-check settings map.
  // Only the map form has keys to validate.
  if (checks && typeof checks === 'object' && !Array.isArray(checks)) {
    for (const [name, settings] of Object.entries(checks)) {
      if (!settings || typeof settings !== 'object') continue;
      for (const key of Object.keys(settings)) {
        if (!PER_CHECK_KEYS.has(key)) perCheck.push(`checks.${name}.${key}`);
      }
    }
  }

  const all = [...unknown, ...perCheck];
  if (!all.length) return [];

  return [
    `\`${configPath}\` declara opciones que este validador no reconoce y que no tendrán efecto: ${all.join(', ')}.`,
  ];
}

/**
 * The check list a repository asks for, or null when it does not ask.
 *
 * Accepts both `"criteria,security"` and `["criteria", "security"]`, because
 * the workflow input is a comma-separated string and a JSON file invites an
 * array — and a config that silently ignores the shape someone naturally wrote
 * is worse than one that accepts both.
 *
 * @returns {string[]|null}
 */
export function requestedChecks(config) {
  const value = config?.checks;

  if (typeof value === 'string') {
    const names = value.split(',').map((name) => name.trim()).filter(Boolean);
    return names.length ? names : null;
  }

  if (Array.isArray(value)) {
    const names = value.map((name) => String(name).trim()).filter(Boolean);
    return names.length ? names : null;
  }

  // An object under `checks` is the per-check settings map, not a list.
  return null;
}

/**
 * Per-check settings, whichever key the repository used.
 *
 * `checks` doubles as the run list, so a repository that uses it that way needs
 * somewhere else to put settings — `checksConfig`.
 */
export function perCheckSettings(config) {
  const checks = config?.checks;
  if (checks && typeof checks === 'object' && !Array.isArray(checks)) return checks;
  return config?.checksConfig ?? {};
}
