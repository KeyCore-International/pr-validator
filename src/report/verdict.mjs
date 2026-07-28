// The contract between check jobs and the report job.
//
// Each check job writes one verdict as an artifact; the report job reads them
// all and renders a single comment. Keeping the shape in one module means the
// two sides cannot drift.
//
// `rows` and `details` are separate on purpose (BR-18): `rows` is the scannable
// table, `details` is prose emitted ONLY where there is something to fix. A
// check cannot leak a task's full text into the comment by accident, because
// there is nowhere in the shape to put it.

export const STATUS = {
  PASS: 'pass',
  FAIL: 'fail',
  TOOL_ERROR: 'tool-error',
  SKIPPED: 'skipped',
};

/** Exit codes the runner maps to. Kept identical to the previous generation. */
export const EXIT = {
  PASS: 0,
  FAIL: 1,
  TOOL_ERROR: 2,
};

/**
 * @param {object} input
 * @param {string} input.check
 * @param {string} input.title
 * @param {string} input.status        One of STATUS.
 * @param {boolean} input.blocking     Whether a FAIL turns the job red.
 * @param {string} [input.summary]
 * @param {Array<{id: string, label: string, verdict: string, evidence: string}>} [input.rows]
 * @param {Array<{id: string, heading: string, body: string}>} [input.details]
 * @param {string[]} [input.notes]     Truncation warnings, skip reasons, errors.
 * @param {string} [input.emptyMessage] Shown instead of an empty table.
 * @param {object} [input.meta]        model, tokens, taskId, counts.
 */
export function makeVerdict({
  check,
  title,
  status,
  blocking,
  summary = '',
  rows = [],
  details = [],
  notes = [],
  emptyMessage = '',
  meta = {},
}) {
  if (!check) throw new Error('verdict requires a check name');
  if (!Object.values(STATUS).includes(status)) {
    throw new Error(`verdict has invalid status "${status}"`);
  }

  return {
    schema: 1,
    check,
    title: title || check,
    status,
    blocking: Boolean(blocking),
    summary: String(summary || ''),
    rows,
    details,
    notes,
    emptyMessage,
    meta,
  };
}

/** Verdict for a check that did not run at all (fork PR, no task, no rules). */
export function skippedVerdict({ check, title, reason, blocking = false, meta = {} }) {
  return makeVerdict({
    check,
    title,
    status: STATUS.SKIPPED,
    blocking,
    notes: [reason],
    emptyMessage: reason,
    meta,
  });
}

/**
 * Verdict for an infrastructure failure. Never blocking regardless of the
 * check's configuration (BR-2): a gateway outage is not a code defect, and
 * blocking on it would hold the whole team hostage to a third party.
 */
export function toolErrorVerdict({ check, title, error, meta = {}, notes = [] }) {
  return makeVerdict({
    check,
    title,
    status: STATUS.TOOL_ERROR,
    blocking: false,
    // The error first, then whatever context notes were already gathered
    // (truncation, loaded rule sources) — those stay useful even on failure.
    notes: [String(error).slice(0, 1500), ...notes],
    emptyMessage: 'El check no pudo ejecutarse. No bloquea el merge.',
    meta,
  });
}

/** Whether this verdict should turn its job red. */
export function isBlockingFailure(verdict) {
  return verdict.status === STATUS.FAIL && verdict.blocking === true;
}

/** Exit code for a verdict, for the check runner. */
export function exitCodeFor(verdict) {
  if (verdict.status === STATUS.TOOL_ERROR) return EXIT.TOOL_ERROR;
  if (verdict.status === STATUS.FAIL) return EXIT.FAIL;
  return EXIT.PASS;
}

/** Guard for verdicts read back from disk, which may be truncated or absent. */
export function isValidVerdict(value) {
  // Boolean(): a nullish input would otherwise leak out as null/undefined and
  // surprise a caller comparing with === false.
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.check === 'string' &&
      Object.values(STATUS).includes(value.status) &&
      Array.isArray(value.rows) &&
      Array.isArray(value.details),
  );
}
