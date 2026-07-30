// Effective configuration for a single check run.
//
// Precedence, lowest to highest:
//   validator defaults  <  check's own config.json  <  workflow inputs
//
// The consuming repository's `.pr-validator.json` slots in above the check
// defaults and below workflow inputs; it is wired in F2.7. `configPath` is
// already accepted here so the call sites do not change when it lands.

// There is deliberately no default model. A silent fallback means a repository
// that never set `PR_VALIDATOR_MODEL` still gets verdicts — from a model nobody
// chose, whose cost and accuracy nobody agreed to. Better to say so out loud:
// `resolveConfig` returns an empty model and the runner reports it as a tool
// error, which warns without blocking the merge.

// `.pr-validator.json` is read from the checkout of the pull request's head, so
// the author of the change under review writes it. That is fine for taste — a
// model, a threshold — and not fine for anything that decides whether the gate
// can fail: a single committed file, in the same commit as the offending code,
// otherwise turns all six checks advisory while every job still reports green.
//
// So a head-side value may **tighten** the gate and never loosen it, and every
// budget is clamped. A budget is a gate control too: `maxDiffChars: 1` leaves
// the model reasoning over one character and answering PASS, which is quieter
// than `blocking: false` because nothing prints a failure at all.
//
// Per-repository loosening is legitimate, it just cannot come from the branch
// being judged — it belongs to the copy of the file on the base branch.

/** Values that apply to every check unless something overrides them. */
export const VALIDATOR_DEFAULTS = {
  blocking: true,
  attempts: 3,
  maxDiffChars: 36000,
  maxRulesChars: 48000,
};

/**
 * Floors and ceilings for anything a repository can set.
 *
 * The floors are what stops a budget from being used as an off switch; they sit
 * below every shipped value, so no default is affected. The ceilings stop the
 * opposite abuse, a budget inflated until the run is unaffordable.
 */
export const BOUNDS = {
  attempts: { min: 1, max: 5 },
  maxDiffChars: { min: 4000, max: 200000 },
  maxRulesChars: { min: 4000, max: 200000 },
  threshold: { min: 0.3, max: 1 },
  maxCandidates: { min: 1, max: 20 },
};

/** Keys that decide whether the gate can fail, so a head-side file cannot relax them. */
export const GATE_KEYS = ['blocking', 'attempts', 'maxDiffChars', 'maxRulesChars'];

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** A number held inside its bounds, or the fallback when it is not a number. */
function clamp(value, bounds, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, n));
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
    // No trailing default: an unconfigured model resolves to '' and the runner
    // turns that into a tool error naming the missing variable.
    model:
      firstDefined(inputs.model, perCheckRepo.model, repoConfig.model, checkConfig.model) ?? '',
    // The repository's own file is absent from this chain on purpose: it may set
    // `blocking: true`, which `||` below honours, but a `false` there cannot
    // disarm a check the validator ships as blocking.
    blocking:
      Boolean(firstDefined(inputs.blocking, checkConfig.blocking, VALIDATOR_DEFAULTS.blocking)) ||
      perCheckRepo.blocking === true,
    // Clamped rather than trusted: `attempts: 0` makes the retry loop body never
    // execute, which reads as a gateway failure and passes the check.
    attempts: clamp(
      firstDefined(perCheckRepo.attempts, checkConfig.attempts, VALIDATOR_DEFAULTS.attempts),
      BOUNDS.attempts,
      VALIDATOR_DEFAULTS.attempts,
    ),
    maxDiffChars: clamp(
      firstDefined(
        perCheckRepo.maxDiffChars,
        repoConfig.maxDiffChars,
        checkConfig.maxDiffChars,
        VALIDATOR_DEFAULTS.maxDiffChars,
      ),
      BOUNDS.maxDiffChars,
      VALIDATOR_DEFAULTS.maxDiffChars,
    ),
    maxRulesChars: clamp(
      firstDefined(
        perCheckRepo.maxRulesChars,
        repoConfig.maxRulesChars,
        checkConfig.maxRulesChars,
        VALIDATOR_DEFAULTS.maxRulesChars,
      ),
      BOUNDS.maxRulesChars,
      VALIDATOR_DEFAULTS.maxRulesChars,
    ),
    // Severities that turn a finding into a failing check. Empty means the
    // check never fails on findings, only reports them.
    // Union, not override. `failOn` decides which verdicts make a check fail, so
    // a head-side `failOn: []` was a way to disarm it — and the only thing that
    // stopped it was every renderer honouring the model's own `overall: FAIL`.
    // That made a probabilistic signal load-bearing for a deterministic gate.
    // Widening the set is a legitimate way to tighten; narrowing it is not.
    failOn: mergeFailOn(checkConfig.failOn, perCheckRepo.failOn),
    // Knobs on `duplication`'s deterministic pre-filter. Deliberately without a
    // validator-wide default: the number belongs to the check that uses it, and
    // a repository drowning in candidates can move it without the validator
    // pretending every check has a threshold.
    threshold: bounded(
      firstDefined(perCheckRepo.threshold, checkConfig.threshold),
      BOUNDS.threshold,
    ),
    maxCandidates: bounded(
      firstDefined(perCheckRepo.maxCandidates, checkConfig.maxCandidates),
      BOUNDS.maxCandidates,
    ),
  };
}

/**
 * The severities that fail a check: what it ships with, plus whatever the
 * repository adds. Never less.
 */
function mergeFailOn(shipped, requested) {
  const base = Array.isArray(shipped) ? shipped : [];
  const extra = Array.isArray(requested) ? requested : [];
  return [...new Set([...base, ...extra])];
}

/** Like `clamp`, but keeps "nobody configured this" distinguishable from a value. */
function bounded(value, bounds) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

/**
 * What the repository asked for that this check refused to honour.
 *
 * Refusing in silence would be its own defect: a repository that set
 * `blocking: false` and saw the check fail anyway deserves to read why, and a
 * reviewer deserves to see that the branch tried.
 *
 * @param {object} repoConfig  Parsed `.pr-validator.json`.
 * @param {string} check       Check name.
 * @returns {string[]}
 */
export function gateOverrideNotes(repoConfig = {}, check = '') {
  const perCheck = repoConfig?.checks?.[check] ?? {};
  const refused = [];

  if (perCheck.blocking === false) refused.push('`blocking: false`');

  for (const key of GATE_KEYS) {
    if (key === 'blocking') continue;
    const asked = firstDefined(perCheck[key], key === 'attempts' ? undefined : repoConfig[key]);
    if (asked === undefined) continue;
    const n = Number(asked);
    const bounds = BOUNDS[key];
    if (!Number.isFinite(n) || n < bounds.min || n > bounds.max) {
      refused.push(`\`${key}: ${asked}\``);
    }
  }

  if (refused.length === 0) return [];
  return [
    `Configuración del repositorio ignorada por afectar al gate: ${refused.join(', ')}. ` +
      'Los ajustes que pueden impedir que un check falle solo se aceptan desde la rama base.',
  ];
}
