// Effective configuration for a single check run.
//
// Precedence, lowest to highest:
//   validator defaults  <  check's own config.json  <  workflow inputs
//
// The consuming repository's `.pr-validator.json` slots in above the check
// defaults and below workflow inputs; it is wired in F2.7. `configPath` is
// already accepted here so the call sites do not change when it lands.

export const DEFAULT_MODEL = 'minimax/minimax-m3';

/** Values that apply to every check unless something overrides them. */
export const VALIDATOR_DEFAULTS = {
  model: DEFAULT_MODEL,
  blocking: true,
  attempts: 3,
  maxDiffChars: 36000,
  maxRulesChars: 48000,
};

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/**
 * Resolve the configuration for one check.
 *
 * @param {object} opts
 * @param {string} opts.check                Check name.
 * @param {object} [opts.checkConfig={}]     Contents of the check's config.json.
 * @param {object} [opts.repoConfig={}]      Parsed `.pr-validator.json` (F2.7).
 * @param {object} [opts.inputs={}]          Workflow inputs / env overrides.
 * @returns {{
 *   check: string, model: string, blocking: boolean, attempts: number,
 *   maxDiffChars: number, maxRulesChars: number, failOn: string[]
 * }}
 */
export function resolveConfig({ check, checkConfig = {}, repoConfig = {}, inputs = {} } = {}) {
  const perCheckRepo = repoConfig?.checks?.[check] ?? {};

  return {
    check,
    model: firstDefined(
      inputs.model,
      perCheckRepo.model,
      repoConfig.model,
      checkConfig.model,
      VALIDATOR_DEFAULTS.model,
    ),
    blocking: Boolean(
      firstDefined(
        inputs.blocking,
        perCheckRepo.blocking,
        checkConfig.blocking,
        VALIDATOR_DEFAULTS.blocking,
      ),
    ),
    attempts: Number(
      firstDefined(perCheckRepo.attempts, checkConfig.attempts, VALIDATOR_DEFAULTS.attempts),
    ),
    maxDiffChars: Number(
      firstDefined(
        perCheckRepo.maxDiffChars,
        repoConfig.maxDiffChars,
        checkConfig.maxDiffChars,
        VALIDATOR_DEFAULTS.maxDiffChars,
      ),
    ),
    maxRulesChars: Number(
      firstDefined(
        perCheckRepo.maxRulesChars,
        repoConfig.maxRulesChars,
        checkConfig.maxRulesChars,
        VALIDATOR_DEFAULTS.maxRulesChars,
      ),
    ),
    // Severities that turn a finding into a failing check. Empty means the
    // check never fails on findings, only reports them.
    failOn: firstDefined(perCheckRepo.failOn, checkConfig.failOn, []),
  };
}
