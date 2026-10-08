// Git access for the local mode.
//
// Every call goes through one function so that every failure surfaces as the
// same error type, which the CLI maps to its git exit code. A raw child-process
// exception reaching the top would read as a crash of the tool rather than as
// "git said no", and the caller acts differently on each.

import { execFileSync } from 'node:child_process';

/** A git invocation failed, or a ref it was asked about does not exist. */
export class GitError extends Error {
  constructor(message, { status = null, stderr = '' } = {}) {
    super(message);
    this.name = 'GitError';
    this.status = status;
    this.stderr = stderr;
  }
}

/**
 * Flags applied to every call: paths printed verbatim (no octal escapes for
 * non-ASCII names), and long paths allowed on Windows checkouts.
 */
const GIT_FLAGS = ['-c', 'core.quotepath=off', '-c', 'core.longpaths=true'];

/**
 * Run git and return its stdout.
 *
 * @param {string} repo
 * @param {string[]} args
 * @param {{allowStatus?: number[]}} [opts] exit statuses that are answers, not failures.
 * @returns {{stdout: string, status: number}}
 */
export function gitRun(repo, args, { allowStatus = [] } = {}) {
  try {
    const stdout = execFileSync('git', [...GIT_FLAGS, '-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Read-only by contract: `status` must not refresh and rewrite the index
      // of a repository it was only asked to describe.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return { stdout, status: 0 };
  } catch (err) {
    if (typeof err.status === 'number' && allowStatus.includes(err.status)) {
      return { stdout: String(err.stdout ?? ''), status: err.status };
    }
    const stderr = String(err.stderr ?? '').trim();
    throw new GitError(`git ${args.join(' ')} failed: ${stderr || err.message}`, {
      status: err.status ?? null,
      stderr,
    });
  }
}

/** Run git and return its trimmed stdout. */
export function git(repo, args) {
  return gitRun(repo, args).stdout.trim();
}

/** The full sha a ref names, or a GitError naming the ref. */
export function resolveSha(repo, ref) {
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new GitError(`ref "${ref}" does not name a commit in ${repo}`);
  }
}

/** Is `ancestor` reachable from `descendant`? */
export function isAncestor(repo, ancestor, descendant) {
  const { status } = gitRun(repo, ['merge-base', '--is-ancestor', ancestor, descendant], {
    allowStatus: [1],
  });
  return status === 0;
}

/** The current branch name, or '' on a detached HEAD. */
export function currentBranch(repo) {
  const { stdout, status } = gitRun(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowStatus: [1, 128],
  });
  return status === 0 ? stdout.trim() : '';
}

/**
 * The branch a detached HEAD sits on, read from the refs that point at it.
 *
 * A worktree checked out on a SHA has no current branch, but the branch it was
 * cut from usually still points at that commit. Local branches are preferred to
 * remote-tracking ones; `exclude` drops names that cannot be the branch under
 * review (the base). Anything but exactly one candidate is '' — a guess between
 * two names would make the facts depend on which one git listed first.
 *
 * @param {string} repo
 * @param {{exclude?: string[]}} [opts]
 * @returns {string}
 */
export function branchAtHead(repo, { exclude = [] } = {}) {
  const refs = gitRun(repo, [
    'for-each-ref',
    '--points-at',
    'HEAD',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
  ])
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const skip = new Set(exclude.map((name) => String(name).replace(/^refs\/heads\//, '')));
  const pick = (names) => [...new Set(names)].filter((name) => name && name !== 'HEAD' && !skip.has(name));

  const local = pick(refs.filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length)));
  if (local.length) return local.length === 1 ? local[0] : '';
  const remote = pick(
    refs
      .filter((ref) => ref.startsWith('refs/remotes/'))
      .map((ref) => ref.slice('refs/remotes/'.length).split('/').slice(1).join('/')),
  );
  return remote.length === 1 ? remote[0] : '';
}

/**
 * The branch under review and where its name came from: the caller's
 * `--branch`, the checked-out branch, or the one ref that points at a detached
 * HEAD (`branchAtHead`). '' with source `null` when none says.
 *
 * @returns {{branch: string, source: 'arg'|'checkout'|'ref'|null}}
 */
export function resolveBranch(repo, { explicit = null, base = null } = {}) {
  const given = String(explicit ?? '').trim();
  if (given) return { branch: given, source: 'arg' };
  const checkout = currentBranch(repo);
  if (checkout) return { branch: checkout, source: 'checkout' };
  const baseName = base ? String(base).replace(/^refs\/(heads|remotes)\//, '') : '';
  const exclude = baseName ? [baseName, baseName.replace(/^[^/]+\//, '')] : [];
  const fromRef = branchAtHead(repo, { exclude });
  return fromRef ? { branch: fromRef, source: 'ref' } : { branch: '', source: null };
}

/** The last segment of a remote URL without `.git`: `git@host:org/api.git` gives `api`. */
export function nameFromRemote(url) {
  const last = String(url ?? '').trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

/**
 * The repository's name, the same from the clone and from every linked worktree:
 *   1. the last segment of the `origin` remote URL;
 *   2. else the folder holding the shared .git directory (the main clone);
 *   3. else the folder of the checkout.
 * Filename-safe, at most 40 characters — the same rule the review plugin uses to
 * name its output folder, so the two never disagree about a repository's name.
 *
 * The folder of a worktree is not the repository: two worktrees of the same
 * commit used to write different facts because each was named after its folder.
 */
export function repoName(repo) {
  const { stdout: url } = gitRun(repo, ['config', '--get', 'remote.origin.url'], { allowStatus: [1] });
  let name = nameFromRemote(url);
  if (!name) {
    const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).replace(/\\/g, '/');
    const parts = common.replace(/\/+$/, '').split('/');
    if (parts.length > 1 && parts[parts.length - 1].toLowerCase() === '.git') name = parts[parts.length - 2];
  }
  if (!name) name = topLevel(repo).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
  return name.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'repo';
}

/** Tracked files with uncommitted changes (staged or not). Untracked files do not count. */
export function dirtyTrackedFiles(repo) {
  const out = gitRun(repo, ['status', '--porcelain', '--untracked-files=no']).stdout;
  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3));
}

/** The repository's top-level directory. */
export function topLevel(repo) {
  return git(repo, ['rev-parse', '--show-toplevel']);
}

/** A file's content at a ref, or null when it does not exist there. */
export function showFile(repo, ref, path) {
  const { stdout, status } = gitRun(repo, ['show', `${ref}:${path}`], { allowStatus: [128] });
  return status === 0 ? stdout : null;
}
