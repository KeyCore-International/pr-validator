import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRawImport } from '../scripts/raw-import.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CHECKS = join(ROOT, 'src/checks');

describe('resolveRawImport', () => {
  // The bundles are committed and compared byte for byte, so the path this
  // returns is part of the artifact: it must stay repo-relative and POSIX.
  it('resolves every prompt import that exists today', () => {
    const dirs = readdirSync(CHECKS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(dirs.length).toBeGreaterThan(0);

    for (const dir of dirs) {
      expect(resolveRawImport('./prompt.md?raw', join(CHECKS, dir), ROOT)).toBe(
        `src/checks/${dir}/prompt.md`,
      );
    }
  });

  // A build inlines whatever it reads into a bundle committed to a public
  // repository, so the specifier must never be able to leave the repository.
  it('refuses a specifier that climbs out of the repository', () => {
    expect(() =>
      resolveRawImport('../../../../../etc/passwd?raw', join(CHECKS, 'security'), ROOT),
    ).toThrow(/outside the repository/);
  });

  it('refuses an absolute specifier', () => {
    expect(() => resolveRawImport('/etc/passwd?raw', join(CHECKS, 'security'), ROOT)).toThrow(
      /outside the repository/,
    );
  });

  // A sibling directory whose name merely starts with the root is not inside
  // it. This is why the check compares path segments, not string prefixes.
  it('refuses a sibling directory that shares the root as a name prefix', () => {
    const root = resolve('/srv/repo');
    const from = resolve('/srv/repo/src/checks/security');

    expect(() => resolveRawImport('../../../../repo-secrets/token.md?raw', from, root)).toThrow(
      /outside the repository/,
    );
  });

  // Containment alone is not enough: the files worth stealing on a maintainer's
  // machine — .env, .git/config — live inside the root.
  it('refuses a file inside the repository but outside src/checks', () => {
    expect(() => resolveRawImport('../../../.env?raw', join(CHECKS, 'security'), ROOT)).toThrow(
      /may only read \.md files/,
    );
  });

  it('refuses a non-Markdown file under src/checks', () => {
    expect(() =>
      resolveRawImport('./config.json?raw', join(CHECKS, 'security'), ROOT),
    ).toThrow(/may only read \.md files/);
  });

  it('refuses a specifier that resolves to the repository root itself', () => {
    expect(() => resolveRawImport('../../..?raw', join(CHECKS, 'security'), ROOT)).toThrow(
      /outside the repository/,
    );
  });

  // The message goes to a public CI log, so it names the specifier and the
  // rule and never the build machine's directory layout.
  it('names the offending specifier without leaking an absolute path', () => {
    let message = '';
    try {
      resolveRawImport('../../../.env?raw', join(CHECKS, 'security'), ROOT);
    } catch (error) {
      message = error.message;
    }

    expect(message).toContain('../../../.env?raw');
    expect(message).not.toContain(ROOT);
  });
});
