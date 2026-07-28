// Report job: collect every check's verdict and publish one comment.
//
// Runs with `needs: [checks]` and `if: always()`, so it sees the verdicts of
// checks that failed as well as those that passed. It never gates: the check
// jobs already turned red or green on their own. Its only job is to tell the
// developer what happened, in one place.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderComment, upsertComment } from './report/comment.mjs';
import { isValidVerdict } from './report/verdict.mjs';

/**
 * Read every `verdict.json` under a directory tree.
 * `download-artifact` creates one subdirectory per artifact, so the files sit
 * one level down; the walk keeps it robust to layout changes.
 */
export function collectVerdicts(dir, { log = console.error } = {}) {
  const found = [];

  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.json')) {
        try {
          const parsed = JSON.parse(readFileSync(full, 'utf8'));
          if (isValidVerdict(parsed)) found.push(parsed);
          else log(`ignoring ${full}: not a valid verdict`);
        } catch (err) {
          // A malformed artifact must not take down the whole report — the
          // check simply shows as "sin resultado".
          log(`ignoring ${full}: ${err.message}`);
        }
      }
    }
  };

  try {
    if (statSync(dir).isDirectory()) walk(dir);
  } catch {
    log(`verdict directory ${dir} does not exist`);
  }

  return found;
}

export function readInputs(env = process.env) {
  return {
    dir: env.INPUT_VERDICTS_DIR || 'verdicts',
    expected: (env.INPUT_CHECKS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    token: env.GITHUB_TOKEN || '',
    repository: env.GITHUB_REPOSITORY || '',
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    issueNumber: env.PR_NUMBER || '',
    headRef: env.PR_HEAD_REF || '',
    dryRun: env.INPUT_DRY_RUN === 'true',
  };
}

export async function main(env = process.env, { log = console.error } = {}) {
  const inputs = readInputs(env);
  const verdicts = collectVerdicts(inputs.dir, { log });

  const taskId = verdicts.map((v) => v.meta?.taskId).find(Boolean) ?? null;

  const body = renderComment({
    verdicts,
    expected: inputs.expected,
    taskId,
    headRef: inputs.headRef,
  });

  if (inputs.dryRun) {
    console.log(body);
    return 0;
  }

  if (!inputs.token || !inputs.repository || !inputs.issueNumber) {
    log('::warning::missing GITHUB_TOKEN, GITHUB_REPOSITORY or PR_NUMBER — printing the comment instead of posting it');
    console.log(body);
    return 0;
  }

  const [owner, repo] = inputs.repository.split('/');

  try {
    const result = await upsertComment({
      token: inputs.token,
      owner,
      repo,
      issueNumber: inputs.issueNumber,
      body,
      apiUrl: inputs.apiUrl,
    });
    log(`comment ${result.action} (${result.id}) with ${verdicts.length} verdicts`);
  } catch (err) {
    // Failing to publish the comment must not fail the PR: the individual
    // check jobs already carry the verdicts.
    log(`::warning::could not publish the consolidated comment: ${err.message}`);
  }

  return 0;
}
