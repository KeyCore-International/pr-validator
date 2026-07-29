import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadRepoConfig,
  perCheckSettings,
  requestedChecks,
} from '../src/context/repo-config.mjs';
import { resolveChecks } from '../src/resolve-checks.mjs';
import { resolveConfig } from '../src/context/config.mjs';
import { listChecks, mandatoryChecks } from '../src/checks/registry.mjs';

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function withConfig(content) {
  dir = mkdtempSync(join(tmpdir(), 'prv-cfg-'));
  if (content !== null) writeFileSync(join(dir, '.pr-validator.json'), content, 'utf8');
  return dir;
}

describe('loadRepoConfig', () => {
  it('treats a missing file as the normal case', () => {
    const out = loadRepoConfig({ repo: withConfig(null) });

    expect(out.present).toBe(false);
    expect(out.config).toEqual({});
    expect(out.notes).toEqual([]);
  });

  // A configuration problem in someone else's repository must not fail the
  // checks on a pull request that has nothing to do with it.
  it('reports malformed JSON without throwing', () => {
    const out = loadRepoConfig({ repo: withConfig('{ "model": }') });

    expect(out.config).toEqual({});
    expect(out.notes[0]).toContain('no es JSON válido');
  });

  it('rejects a top-level array', () => {
    const out = loadRepoConfig({ repo: withConfig('["criteria"]') });

    expect(out.config).toEqual({});
    expect(out.notes[0]).toContain('objeto JSON');
  });

  // A typo is otherwise invisible: the repository believes it changed the
  // model, the validator carries on with the default, and nothing says so.
  it('names keys that will have no effect', () => {
    const out = loadRepoConfig({
      repo: withConfig(JSON.stringify({ modle: 'x', checks: { security: { blokcing: false } } })),
    });

    expect(out.notes[0]).toContain('modle');
    expect(out.notes[0]).toContain('checks.security.blokcing');
  });

  it('stays quiet when every key is recognised', () => {
    const out = loadRepoConfig({
      repo: withConfig(JSON.stringify({ model: 'x', checks: { security: { blocking: false } } })),
    });

    expect(out.notes).toEqual([]);
  });
});

describe('requestedChecks', () => {
  it('accepts an array', () => {
    expect(requestedChecks({ checks: ['criteria', 'security'] })).toEqual(['criteria', 'security']);
  });

  // The workflow input is a comma-separated string, so somebody will write one
  // in the file too. Ignoring the shape they naturally reached for is worse
  // than accepting both.
  it('accepts a comma-separated string', () => {
    expect(requestedChecks({ checks: 'criteria, security' })).toEqual(['criteria', 'security']);
  });

  it('reads an object as per-check settings, not as a list', () => {
    expect(requestedChecks({ checks: { security: { blocking: false } } })).toBeNull();
  });

  it('returns null when nothing is declared', () => {
    expect(requestedChecks({})).toBeNull();
  });
});

describe('perCheckSettings', () => {
  it('reads the object form of `checks`', () => {
    expect(perCheckSettings({ checks: { security: { model: 'x' } } })).toEqual({
      security: { model: 'x' },
    });
  });

  // `checks` doubles as the run list, so a repository using it that way needs
  // somewhere else for settings.
  it('falls back to `checksConfig` when `checks` is a list', () => {
    expect(perCheckSettings({ checks: ['security'], checksConfig: { security: { model: 'x' } } })).toEqual(
      { security: { model: 'x' } },
    );
  });

  it('is empty when neither is present', () => {
    expect(perCheckSettings({})).toEqual({});
  });
});

describe('resolveConfig with a repository config', () => {
  // US-17's confirmation: a repository pinning a different model for one check
  // sees it on that check and only that one.
  it('applies a per-check model to that check alone', () => {
    const repoConfig = { model: 'global/model', checks: { duplication: { model: 'otro/modelo' } } };

    expect(resolveConfig({ check: 'duplication', repoConfig }).model).toBe('otro/modelo');
    expect(resolveConfig({ check: 'security', repoConfig }).model).toBe('global/model');
  });

  it('lets the workflow input win over the file', () => {
    const out = resolveConfig({
      check: 'security',
      repoConfig: { model: 'del/archivo' },
      inputs: { model: 'del/workflow' },
    });

    expect(out.model).toBe('del/workflow');
  });

  it('carries the duplication threshold through', () => {
    const out = resolveConfig({
      check: 'duplication',
      checkConfig: { threshold: 0.55 },
      repoConfig: { checks: { duplication: { threshold: 0.7 } } },
    });

    expect(out.threshold).toBe(0.7);
  });
});

describe('resolveChecks', () => {
  it('uses the workflow input when it has one', () => {
    const out = resolveChecks({ input: 'security, rules', repo: withConfig(null) });

    expect(out.checks).toEqual(['security', 'rules']);
  });

  it('falls back to the repository config when the input is empty', () => {
    const out = resolveChecks({ repo: withConfig(JSON.stringify({ checks: ['security'] })) });

    expect(out.checks).toContain('security');
    expect(out.source).toContain('.pr-validator.json');
  });

  it('runs every implemented check when nobody says otherwise', () => {
    const out = resolveChecks({ repo: withConfig(null) });

    expect(out.checks).toEqual(listChecks());
  });

  it('drops an unknown name and says which one', () => {
    const out = resolveChecks({ input: 'security,qualty', repo: withConfig(null) });

    expect(out.checks).toEqual(['security']);
    expect(out.warnings[0]).toContain('qualty');
    expect(out.warnings[0]).toContain('quality');
  });

  // Running nothing would leave the pull request unreviewed with every status
  // check green — a gate that protects nothing and says nothing.
  it('falls back to all checks when every name is wrong', () => {
    const out = resolveChecks({ input: 'nope,alsonope', repo: withConfig(null) });

    expect(out.checks).toEqual(listChecks());
    expect(out.warnings.some((w) => w.includes('Ningún nombre válido'))).toBe(true);
  });

  it('returns names in display order regardless of how they were written', () => {
    const out = resolveChecks({ input: 'tests,criteria,security', repo: withConfig(null) });

    expect(out.checks).toEqual(['criteria', 'security', 'tests']);
  });

  it('carries the config file warnings through', () => {
    const out = resolveChecks({ repo: withConfig('{ nope }') });

    expect(out.warnings[0]).toContain('no es JSON válido');
  });
});

// `.pr-validator.json` is read from the head checkout, so a run list in it is the
// author of the change choosing which checks are allowed to judge it. The
// consolidated comment cannot even disclose the omission: its order is built from
// the resolved matrix, so a check that never ran has no row to be missing from.
describe('a head-side run list cannot remove a blocking check', () => {
  it('puts the omitted blocking checks back', () => {
    const out = resolveChecks({ repo: withConfig(JSON.stringify({ checks: ['rules'] })) });

    expect(out.checks).toEqual(expect.arrayContaining(mandatoryChecks()));
    expect(out.checks).toContain('rules');
  });

  it('says which ones it put back', () => {
    const out = resolveChecks({ repo: withConfig(JSON.stringify({ checks: ['rules'] })) });

    expect(out.warnings.some((w) => w.includes('omite checks bloqueantes'))).toBe(true);
  });

  it('still lets the file add a check', () => {
    const out = resolveChecks({ repo: withConfig(JSON.stringify({ checks: listChecks() })) });

    expect(out.checks).toEqual(listChecks());
    expect(out.warnings.some((w) => w.includes('omite checks bloqueantes'))).toBe(false);
  });

  // The input comes from the consumer's own workflow on the base branch, which is
  // not the branch under review, so narrowing there is a legitimate choice.
  it('leaves the workflow input free to narrow the run', () => {
    const out = resolveChecks({ input: 'rules', repo: withConfig(null) });

    expect(out.checks).toEqual(['rules']);
  });
});
