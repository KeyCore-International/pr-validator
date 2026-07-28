// Build a throwaway git repository on disk so the diff layer is tested against
// real `git diff` output rather than a hand-written patch that may not match
// what git actually emits.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

/**
 * Create a repo with a `base` branch and a `feature` branch on top.
 *
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.baseFiles]
 * @param {Record<string,string>} [opts.featureFiles]
 * @returns {{dir: string, cleanup: () => void}}
 */
export function makeRepo({ baseFiles = {}, featureFiles = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prv-'));

  git(dir, ['init', '-b', 'base', '--quiet']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);

  write(dir, { 'README.md': '# fixture\n', ...baseFiles });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base', '--quiet']);

  git(dir, ['checkout', '-b', 'feature', '--quiet']);
  if (Object.keys(featureFiles).length) {
    write(dir, featureFiles);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'feature', '--quiet']);
  }

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
}

/** Generate a file big enough to blow past a small diff budget. */
export function bigFile(lines, prefix = 'line') {
  return Array.from({ length: lines }, (_, i) => `${prefix} ${i} ${'x'.repeat(60)}`).join('\n') + '\n';
}
