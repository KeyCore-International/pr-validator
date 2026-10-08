// Exit codes of the local CLI, and the errors that carry them.
//
// Each refusal has its own code because the caller acts differently on each:
// a dirty tree is fixed by committing, a base that is not an ancestor by
// merging or rebasing, and a moved HEAD by running again. One generic failure
// code would leave the caller parsing English to decide.

export const EXIT = {
  OK: 0,
  USAGE: 1,
  GIT: 2,
  DIRTY: 4,
  NOT_ANCESTOR: 5,
  HEAD_MOVED: 6,
};

export class LocalError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'LocalError';
    this.exitCode = exitCode;
  }
}

export class UsageError extends LocalError {
  constructor(message) {
    super(message, EXIT.USAGE);
    this.name = 'UsageError';
  }
}

export class DirtyTreeError extends LocalError {
  constructor(files) {
    super(
      `tracked files have uncommitted changes (${files.length}): ${files.slice(0, 10).join(', ')}` +
        `${files.length > 10 ? ', …' : ''}. Commit or stash them: a result must be tied to a commit.`,
      EXIT.DIRTY,
    );
    this.name = 'DirtyTreeError';
    this.files = files;
  }
}

export class NotAncestorError extends LocalError {
  constructor(ancestor, descendant) {
    super(`${ancestor} is not an ancestor of ${descendant}. Bring the branch up to date first.`, EXIT.NOT_ANCESTOR);
    this.name = 'NotAncestorError';
  }
}

export class HeadMovedError extends LocalError {
  constructor(expected, actual) {
    super(`HEAD moved: expected ${expected}, found ${actual}. Run again on a stable HEAD.`, EXIT.HEAD_MOVED);
    this.name = 'HeadMovedError';
  }
}
