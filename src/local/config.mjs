// Configuration as a check run sees it, plus the `local` block.
//
// The per-check resolution is the runner's own (`resolveConfig` over the same
// normalised file), so a threshold or budget means the same thing locally as in
// CI. The `local` block is passed through untouched: deciding which of its keys
// may be trusted from the branch under review is the caller's policy, and the
// caller gets both copies — the head's and the base's — to apply it.

import { resolveConfig } from '../context/config.mjs';
import { DEFAULT_CONFIG_PATH, loadRepoConfig, perCheckSettings } from '../context/repo-config.mjs';
import { getCheck, listChecks } from '../checks/registry.mjs';
import { showFile } from './git.mjs';

/**
 * The effective configuration of one check, exactly as `runCheck` resolves it.
 *
 * @param {{config: object}} repoConfig  `loadRepoConfig()` output.
 * @param {string} name
 * @param {{model?: string}} [inputs]
 */
export function checkConfig(repoConfig, name, inputs = {}) {
  const check = getCheck(name);
  return resolveConfig({
    check: name,
    checkConfig: check.config,
    repoConfig: { ...repoConfig.config, checks: perCheckSettings(repoConfig.config) },
    inputs: inputs.model ? { model: inputs.model } : {},
  });
}

/** The `local` block of a parsed config, or null. */
function localBlock(config) {
  const local = config?.local;
  return local && typeof local === 'object' && !Array.isArray(local) ? local : null;
}

/** The config file as committed on another ref, parsed; `present: false` when absent. */
export function configAtRef(repo, ref, configPath = DEFAULT_CONFIG_PATH) {
  const raw = showFile(repo, ref, configPath);
  if (raw === null) return { present: false, config: {}, error: null };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { present: true, config: {}, error: 'not a JSON object' };
    }
    return { present: true, config: parsed, error: null };
  } catch (err) {
    return { present: true, config: {}, error: err.message };
  }
}

/**
 * Everything `config` prints.
 *
 * @param {object} opts
 * @param {string} opts.repo
 * @param {string} [opts.configPath]
 * @param {string|null} [opts.base]  When set, the base ref's copy is read as well.
 */
export function resolveRepoConfig({ repo, configPath = DEFAULT_CONFIG_PATH, base = null }) {
  const head = loadRepoConfig({ repo, configPath });

  const checks = {};
  for (const name of listChecks()) checks[name] = checkConfig(head, name);

  const out = {
    configPath,
    head: {
      present: head.present,
      notes: head.notes,
      config: head.config,
      local: localBlock(head.config),
    },
    checks,
    base: null,
  };

  if (base) {
    const atBase = configAtRef(repo, base, configPath);
    out.base = {
      ref: base,
      present: atBase.present,
      error: atBase.error,
      config: atBase.config,
      local: localBlock(atBase.config),
    };
  }

  return out;
}
