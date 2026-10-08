// What the branch's own history says: its commits, merges that brought in
// someone else's work, and commit messages that credit a tool as an author.
//
// A merge of another feature branch puts code under review that nobody asked
// to review here, and its findings get attributed to the wrong change. It is
// reported, never silently folded into the diff.

import { gitRun, isAncestor } from './git.mjs';

/**
 * Commit-message patterns that read as tool attribution.
 *
 * Neutral on purpose — no product is named here. A caller that wants to match
 * specific tool names passes its own patterns, which are added to these.
 * A human co-author on a hosting provider's noreply address is not matched.
 */
export const DEFAULT_ATTRIBUTION_PATTERNS = [
  '/^\\s*generated (with|by)\\b/im',
  '/^\\s*co-authored-by:[^\\n]*<[^>\\n]*noreply@(?!users\\.noreply\\.github\\.com)[^>\\n]*>/im',
  '/\\u{1F916}/u',
];

const RECORD = '\x1e';
const FIELD = '\x1f';

/**
 * Commits in `from..to`, oldest first.
 *
 * @returns {Array<{sha: string, parents: string[], subject: string, body: string}>}
 */
export function listCommits(repo, from, to) {
  const format = ['%H', '%P', '%s', '%B'].join(FIELD) + RECORD;
  const out = gitRun(repo, ['log', '--reverse', `--format=${format}`, `${from}..${to}`]).stdout;
  return out
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, parents, subject, body] = record.split(FIELD);
      return {
        sha: sha.trim(),
        parents: parents.trim().split(/\s+/).filter(Boolean),
        subject: subject ?? '',
        body: body ?? '',
      };
    });
}

/**
 * Merges whose merged-in side is neither the base branch nor this branch's own
 * remote copy.
 *
 * Topology alone cannot tell "pulled my own branch" from "merged a colleague's
 * branch" — both sides are new to the base. The merge subject git writes for a
 * pull of the same branch is what tells them apart.
 *
 * @returns {Array<{sha: string, subject: string, parent: string, commits: number}>}
 */
export function foreignMerges(repo, commits, { baseSha, branch = '' }) {
  const out = [];
  const ownPull = branch
    ? new RegExp(
        `^Merge (remote-tracking )?branch '(origin/)?${escapeRegExp(branch)}'`,
      )
    : null;

  for (const commit of commits) {
    if (commit.parents.length < 2) continue;
    if (ownPull?.test(commit.subject)) continue;

    for (const parent of commit.parents.slice(1)) {
      // Bringing the base in is how a branch stays current, not foreign work.
      if (isAncestor(repo, parent, baseSha)) continue;

      const count = gitRun(repo, [
        'rev-list',
        '--count',
        parent,
        `^${baseSha}`,
        `^${commit.parents[0]}`,
      ]).stdout.trim();

      out.push({
        sha: commit.sha,
        subject: commit.subject.slice(0, 200),
        parent,
        commits: Number(count) || 0,
      });
    }
  }
  return out;
}

/**
 * Commit-message lines that credit a tool.
 *
 * @param {Array<{sha: string, subject: string, body: string}>} commits
 * @param {RegExp[]} patterns
 * @returns {Array<{sha: string, line: string}>}
 */
export function attributionHits(commits, patterns) {
  const out = [];
  for (const commit of commits) {
    // `%B` already starts with the subject.
    const message = commit.body || commit.subject;
    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (!match) continue;
      // The whole line the match sits on, which is what a reviewer looks for.
      // A leading `\s*` can match the preceding newlines, so anchor on the
      // first visible character of the match.
      const at = match.index + (match[0].length - match[0].trimStart().length);
      const start = message.lastIndexOf('\n', at - 1) + 1;
      const end = message.indexOf('\n', at);
      const line = message.slice(start, end === -1 ? undefined : end).trim();
      out.push({ sha: commit.sha, line: line.slice(0, 200) });
      break;
    }
  }
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
