// How much review a change gets: XS, S, M or L.
//
// Size alone is a poor proxy for risk — a forty-line authorization change
// deserves more than a thousand lines of form markup — so triggers escalate,
// and some of them escalate on their own. The thresholds are starting values
// meant to be calibrated, which is why they are parameters.

export const DEFAULT_THRESHOLDS = { sMax: 400, mMax: 1500 };

/** Triggers that never allow the smallest reviewed tier. */
export const HARD_TRIGGERS = ['AUTH', 'MIG', 'WRITE', 'SEED'];

/** Triggers that mark a change, but never raise its tier. */
export const NON_ESCALATING = ['FIX'];

/**
 * @param {object} opts
 * @param {number} opts.prodLines
 * @param {string[]} opts.triggers  Trigger ids that fired.
 * @param {{sMax?: number, mMax?: number}} [opts.thresholds]
 * @param {'quick'|'full'|null} [opts.force]
 * @returns {{value: 'XS'|'S'|'M'|'L', computed: string, reasons: string[],
 *            forced: string|null, refused: string|null}}
 */
export function computeTier({ prodLines, triggers = [], thresholds = {}, force = null }) {
  const { sMax, mMax } = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const counted = [...new Set(triggers)].filter((id) => !NON_ESCALATING.includes(id)).sort();
  const has = (id) => counted.includes(id);
  const hard = counted.filter((id) => HARD_TRIGGERS.includes(id));

  let computed;
  const reasons = [];

  if (prodLines === 0) {
    computed = 'XS';
    reasons.push('0 production lines');
  } else {
    const large = [];
    if (prodLines > mMax) large.push(`${prodLines} production lines > ${mMax}`);
    if (counted.length >= 3) large.push(`${counted.length} triggers (${counted.join(', ')})`);
    if (has('SEED')) large.push('SEED');
    if (has('MIG') && has('WRITE')) large.push('MIG + WRITE');

    const medium = [];
    if (prodLines > sMax) medium.push(`${prodLines} production lines > ${sMax}`);
    if (counted.length === 2) medium.push(`2 triggers (${counted.join(', ')})`);
    if (hard.length) medium.push(`hard trigger (${hard.join(', ')})`);

    if (large.length) {
      computed = 'L';
      reasons.push(...large);
    } else if (medium.length) {
      computed = 'M';
      reasons.push(...medium);
    } else {
      computed = 'S';
      // A FIX that fired is named even though it does not escalate: "no
      // triggers" next to a FIX in the trigger list reads as a contradiction.
      const marking = [...new Set(triggers)].filter((id) => NON_ESCALATING.includes(id)).sort();
      reasons.push(
        `${prodLines} production lines <= ${sMax}` +
          (counted.length
            ? `, 1 trigger (${counted[0]})`
            : marking.length
              ? `, no escalating triggers (${marking.join(', ')} does not escalate)`
              : ', no triggers'),
      );
    }
  }

  let value = computed;
  let forced = null;
  let refused = null;

  if (force === 'full') {
    value = 'L';
    forced = 'full';
  } else if (force === 'quick') {
    // A quick pass over authorization, a migration, a write path or a seed is
    // exactly the review that misses what matters, so it is refused, and the
    // refusal is recorded rather than silently ignored.
    if (hard.length) {
      refused = `quick refused: ${hard.join(', ')}`;
    } else if (computed !== 'XS') {
      value = 'S';
      forced = 'quick';
    }
  }

  return { value, computed, reasons, forced, refused };
}
