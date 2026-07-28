// Resolve which task a pull request belongs to.
//
// Phase 1 resolves from the branch name only, matching the behaviour this tool
// had before it was extracted. `prTitle` is already part of the signature so
// that adding title resolution later does not change any call site.
//
// Modes:
//   task    -> a task id was resolved; the criteria check runs
//   exempt  -> the branch is not task work (chores, hotfixes, back-merges);
//              the criteria check passes green without running
//   invalid -> no id anywhere and no exemption; the convention is enforced

/** Branch prefixes and long-lived branches that legitimately carry no task. */
export const EXEMPT_PATTERN =
  /^(?:chore|hotfix|release|dependabot|renovate)\/|^(?:master|main|qa|develop)$/;

const BRANCH_TASK_PATTERN = /^feature\/(\d+)-/;

/**
 * Extract a fenced ```criteria block from a PR body.
 * @returns {string} The block contents, or '' when absent.
 */
export function extractCriteriaBlock(prBody) {
  const match = String(prBody || '').match(/```criteria\s*\n([\s\S]*?)```/i);
  return match && match[1].trim() ? `${match[1].trim()}\n` : '';
}

/**
 * @param {object} opts
 * @param {string} opts.headRef   PR head branch name.
 * @param {string} [opts.prTitle] PR title. Ignored in phase 1 (see F2.1).
 * @param {string} [opts.prBody]  PR body, for the fallback criteria block.
 * @returns {{
 *   mode: 'task'|'exempt'|'invalid',
 *   taskId: string|null,
 *   source: 'branch'|'title'|'body'|null,
 *   criteriaBlock: string
 * }}
 */
export function resolveTaskRef({ headRef = '', prTitle = '', prBody = '' } = {}) {
  const criteriaBlock = extractCriteriaBlock(prBody);

  const fromBranch = headRef.match(BRANCH_TASK_PATTERN);
  if (fromBranch) {
    return { mode: 'task', taskId: fromBranch[1], source: 'branch', criteriaBlock };
  }

  if (EXEMPT_PATTERN.test(headRef)) {
    return { mode: 'exempt', taskId: null, source: null, criteriaBlock };
  }

  // A branch with no id that is not exempt still has a usable fallback if the
  // author wrote the criteria into the PR body by hand.
  if (criteriaBlock) {
    return { mode: 'task', taskId: null, source: 'body', criteriaBlock };
  }

  return { mode: 'invalid', taskId: null, source: null, criteriaBlock };
}
