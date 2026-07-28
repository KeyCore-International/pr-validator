import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadRules, rulesTruncationNote } from '../src/context/rules.mjs';
import { resolveConfig, VALIDATOR_DEFAULTS } from '../src/context/config.mjs';

const CORPUS = join(import.meta.dirname, 'fixtures', 'rules-corpus');

describe('loadRules', () => {
  it('loads every rule file when the budget allows', () => {
    const rules = loadRules({ rulesDir: CORPUS, maxChars: 100000 });

    expect(rules.empty).toBe(false);
    expect(rules.sources).toHaveLength(3);
    expect(rules.truncated).toBe(false);
    expect(rulesTruncationNote(rules)).toBeNull();
  });

  it('labels sources with a repo-relative posix path', () => {
    const rules = loadRules({ rulesDir: CORPUS, maxChars: 100000 });
    const paths = rules.sources.map((s) => s.path);

    expect(paths).toContain('api/controllers.md');
    expect(paths).toContain('code-style/naming.md');
    expect(paths.every((p) => !p.includes('\\'))).toBe(true);
  });

  it('reports an empty corpus rather than pretending the repo complies', () => {
    const rules = loadRules({ rulesDir: join(CORPUS, 'does-not-exist') });

    expect(rules.empty).toBe(true);
    expect(rules.sources).toHaveLength(0);
  });

  it('drops whole files rather than half a rule', () => {
    const rules = loadRules({ rulesDir: CORPUS, maxChars: 700 });

    expect(rules.truncated).toBe(true);
    expect(rules.omittedSources.length).toBeGreaterThan(0);
    // Whatever survived is complete: no section is cut mid-file.
    for (const source of rules.sources) {
      expect(rules.text).toContain(`### ${source.path}`);
    }
  });

  it('names the omitted files so the gap is visible', () => {
    const rules = loadRules({ rulesDir: CORPUS, maxChars: 700 });
    const note = rulesTruncationNote(rules);

    expect(note).toContain('Omitidos por presupuesto');
    expect(note).toContain(rules.omittedSources[0].path);
  });

  it('counts the full corpus size even when it truncates', () => {
    const full = loadRules({ rulesDir: CORPUS, maxChars: 100000 });
    const cut = loadRules({ rulesDir: CORPUS, maxChars: 700 });

    expect(cut.totalChars).toBe(full.totalChars);
  });
});

describe('resolveConfig', () => {
  it('falls back to the validator defaults', () => {
    const config = resolveConfig({ check: 'security' });

    expect(config.blocking).toBe(true);
    expect(config.attempts).toBe(3);
  });

  it('leaves the model empty when nothing configures one', () => {
    const config = resolveConfig({ check: 'security' });

    expect(config.model).toBe('');
    expect(VALIDATOR_DEFAULTS.model).toBeUndefined();
  });

  it("lets a check's own config override the defaults", () => {
    const config = resolveConfig({ check: 'quality', checkConfig: { blocking: false, model: 'x/y' } });

    expect(config.blocking).toBe(false);
    expect(config.model).toBe('x/y');
  });

  it('lets the repository override the check config', () => {
    const config = resolveConfig({
      check: 'rules',
      checkConfig: { model: 'check/model', blocking: true },
      repoConfig: { checks: { rules: { model: 'repo/model', blocking: false } } },
    });

    expect(config.model).toBe('repo/model');
    expect(config.blocking).toBe(false);
  });

  it('lets a repo-wide model apply to a check with no explicit model', () => {
    const config = resolveConfig({ check: 'rules', repoConfig: { model: 'repo/wide' } });

    expect(config.model).toBe('repo/wide');
  });

  it('gives workflow inputs the last word', () => {
    const config = resolveConfig({
      check: 'criteria',
      checkConfig: { model: 'check/model' },
      repoConfig: { model: 'repo/model' },
      inputs: { model: 'input/model' },
    });

    expect(config.model).toBe('input/model');
  });

  it('ignores empty overrides instead of blanking the value', () => {
    const config = resolveConfig({
      check: 'criteria',
      checkConfig: { model: 'check/model' },
      inputs: { model: '' },
    });

    expect(config.model).toBe('check/model');
  });

  it('carries failOn through from the check config', () => {
    const config = resolveConfig({ check: 'security', checkConfig: { failOn: ['high'] } });

    expect(config.failOn).toEqual(['high']);
  });
});
