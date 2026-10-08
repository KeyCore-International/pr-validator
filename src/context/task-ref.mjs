// Resolve which task a pull request belongs to.
//
// Three sources, in order of precedence: branch name, PR title, PR body. The
// branch comes first because it is the one place the id appears without anybody
// having to remember anything — but a title-declared id resolves just as well.
//
// The naming convention is a shortcut, not a rule. There is deliberately no
// "invalid" mode: a pull request carrying no task reference has nothing to
// validate against, which is not the same as a violation. That mode used to be
// the only source of a blocking verdict about metadata rather than about code,
// and deleting it is what makes that outcome impossible rather than merely
// discouraged.
//
// Modes:
//   task -> a subject was resolved; the criteria check runs against it
//   none -> no reference anywhere; the criteria check is skipped, green

/** `fix/3002-slug`, `3002-slug`, `feature/3002-slug` — any prefix, or none. */
const BRANCH_ID = /(?:^|\/)(\d+)-/;

/**
 * `#3002`, `[3002]`, `(#3002)` — the forms a developer actually writes.
 *
 * A bracket or parenthesis glued to a word is an argument or an index, not a
 * reference: `nvarchar(1000)`, `decimal(18)`, `items[2]`. Those are left out;
 * `(#3002)` still resolves anywhere through the `#` form.
 */
const TEXT_ID = /#(\d+)|(?<![\w$])\[(\d+)\]|(?<![\w$])\((?:#)?(\d+)\)/g;

/**
 * The body's form: `#3002` only. A body is prose, and prose puts bare numbers in
 * brackets all the time — "sin código (3)", "fallan solo en la rama (5)" — which
 * the title, one line naming the change, does not.
 */
const HASH_ID = /#(\d+)/g;

/**
 * Extra tasks pulled in as context. Bounded because each one is a request and a
 * slice of the prompt budget, and a pull request that genuinely spans more than
 * a handful of tasks has a problem no amount of context will fix.
 */
export const MAX_CONTEXT_TASKS = 3;

/**
 * Extract a fenced ```criteria block from a PR body.
 * @returns {string} The block contents, or '' when absent.
 */
export function extractCriteriaBlock(prBody) {
  const match = String(prBody || '').match(/```criteria\s*\n([\s\S]*?)```/i);
  return match && match[1].trim() ? `${match[1].trim()}\n` : '';
}

/**
 * Every task id in a free-text field, in the order they appear.
 *
 * @param {string} text
 * @param {{hashOnly?: boolean}} [opts] `hashOnly` reads `#3002` alone (the body).
 * @returns {string[]}
 */
export function idsFromText(text, { hashOnly = false } = {}) {
  const out = [];
  for (const match of String(text || '').matchAll(hashOnly ? HASH_ID : TEXT_ID)) {
    const id = match[1] ?? match[2] ?? match[3];
    if (id) out.push(id);
  }
  return out;
}

/** The single id a branch name carries, if any. */
export function idFromBranch(headRef) {
  const match = String(headRef || '').match(BRANCH_ID);
  return match ? match[1] : null;
}

/**
 * @param {object} opts
 * @param {string} opts.headRef   PR head branch name.
 * @param {string} [opts.prTitle] PR title.
 * @param {string} [opts.prBody]  PR body.
 * @returns {{
 *   mode: 'task'|'none',
 *   subjectId: string|null,
 *   source: 'branch'|'title'|'body'|null,
 *   contextIds: string[],
 *   criteriaBlock: string
 * }}
 */
export function resolveTaskRef({ headRef = '', prTitle = '', prBody = '' } = {}) {
  const criteriaBlock = extractCriteriaBlock(prBody);

  const branchId = idFromBranch(headRef);
  const titleIds = idsFromText(prTitle);
  const bodyIds = idsFromText(prBody, { hashOnly: true });

  // Precedence picks the source; inside the winning source the first id wins.
  // Positional on purpose: two runs over the same pull request have to choose
  // the same subject, and "the first one" is the only rule that guarantees it.
  let subjectId = null;
  let source = null;
  if (branchId) {
    subjectId = branchId;
    source = 'branch';
  } else if (titleIds.length) {
    subjectId = titleIds[0];
    source = 'title';
  } else if (bodyIds.length) {
    subjectId = bodyIds[0];
    source = 'body';
  }

  if (!subjectId) {
    // A hand-written criteria block is still a usable contract with no id at
    // all: the author wrote down what the change has to satisfy.
    if (criteriaBlock) {
      return { mode: 'task', subjectId: null, source: 'body', contextIds: [], criteriaBlock };
    }
    return { mode: 'none', subjectId: null, source: null, contextIds: [], criteriaBlock };
  }

  // Everything else mentioned anywhere travels as context. A body reading
  // "incidencia #3002 de la tarea #3001" makes #3001 available to the model
  // without ever turning its criteria into a requirement.
  const contextIds = [];
  for (const id of [branchId, ...titleIds, ...bodyIds]) {
    if (!id || id === subjectId || contextIds.includes(id)) continue;
    contextIds.push(id);
    if (contextIds.length === MAX_CONTEXT_TASKS) break;
  }

  return { mode: 'task', subjectId, source, contextIds, criteriaBlock };
}
