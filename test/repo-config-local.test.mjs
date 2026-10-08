// Keys `.pr-validator.json` accepts beyond the pull request run's own: the
// `local` block a developer's machine reads, and the duplication settings.
//
// A key that is accepted must not be reported as a typo, and a key that only
// one check understands must still be reported when it is written on another.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRepoConfig } from '../src/context/repo-config.mjs';

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function load(config) {
  dir = mkdtempSync(join(tmpdir(), 'prv-cfg-local-'));
  writeFileSync(join(dir, '.pr-validator.json'), JSON.stringify(config), 'utf8');
  return loadRepoConfig({ repo: dir });
}

describe('the top-level local block', () => {
  it('is accepted without a note, whatever it holds', () => {
    const out = load({
      model: 'x',
      local: {
        stacks: [{ name: 'dotnet', root: 'api' }],
        commands: { test: null },
        anythingTheLocalRunnerAddsLater: { nested: true },
      },
    });

    expect(out.notes).toEqual([]);
    expect(out.config.local.commands).toEqual({ test: null });
  });

  // Its contents belong to the local runner; the pull request run neither
  // validates nor obeys them.
  it('does not validate the keys inside it', () => {
    expect(load({ local: { notAKnownKey: 1 } }).notes).toEqual([]);
  });

  it('still reports a misspelt sibling', () => {
    const out = load({ local: {}, lcoal: {} });

    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toContain('no tendrán efecto: lcoal.');
  });
});

describe('duplication allow and reference', () => {
  it('are accepted on the duplication check', () => {
    const out = load({
      checks: {
        duplication: {
          threshold: 0.7,
          allow: [['src/a.ts#formatDate', 'src/b.ts#formatDate']],
          reference: 'src/helpers',
        },
      },
    });

    expect(out.notes).toEqual([]);
  });

  it('are reported on a check that does not understand them', () => {
    const out = load({ checks: { security: { allow: [], reference: 'x' } } });

    expect(out.notes[0]).toContain('checks.security.allow');
    expect(out.notes[0]).toContain('checks.security.reference');
  });

  it('do not let a check named after a prototype key throw', () => {
    const out = load({ checks: { constructor: { allow: [] } } });

    expect(out.notes[0]).toContain('checks.constructor.allow');
  });

  it('still report an unknown key next to them', () => {
    const out = load({ checks: { duplication: { allow: [], treshold: 0.7 } } });

    expect(out.notes[0]).toContain('checks.duplication.treshold');
    expect(out.notes[0]).not.toContain('checks.duplication.allow');
  });
});
