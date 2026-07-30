import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  declaredScope,
  loadRules,
  matchesAny,
  rulesSourceNotes,
  rulesTruncationNote,
} from '../src/context/rules.mjs';
import * as rules from '../src/checks/rules/render.mjs';
import { cacheOptions, effortOptions, providerOptionsFor } from '../src/run-check.mjs';
import { getCheck } from '../src/checks/registry.mjs';
import {
  BOUNDS,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  gateOverrideNotes,
  resolveConfig,
  VALIDATOR_DEFAULTS,
} from '../src/context/config.mjs';

const CORPUS = join(import.meta.dirname, 'fixtures', 'rules-corpus');

let repoDir;
afterEach(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  repoDir = undefined;
});

/** A throwaway repository tree with the given files. */
function makeTree(files) {
  repoDir = mkdtempSync(join(tmpdir(), 'prv-rules-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(repoDir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return repoDir;
}

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

describe('rule sources beyond .claude/rules', () => {
  it('reads the conventions a repository actually wrote, wherever they live', () => {
    const repo = makeTree({
      '.claude/rules/naming.md': '# Naming\nPascalCase.\n',
      '.cursor/rules/api.mdc': '# API\nUn controlador por recurso.\n',
      'CLAUDE.md': '# Proyecto\nNada de console.log.\n',
      'CONTRIBUTING.md': '# Contribuir\nCommits en inglés.\n',
      '.github/copilot-instructions.md': '# Copilot\nUsa async/await.\n',
    });

    const paths = loadRules({ repo }).sources.map((s) => s.path);

    expect(paths).toContain('naming.md');
    expect(paths).toContain('api.mdc');
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('CONTRIBUTING.md');
    expect(paths).toContain('.github/copilot-instructions.md');
  });

  // Order is the budget policy: a folder somebody created to hold rules says
  // more than a root file that also explains how to run the tests.
  it('loads dedicated rule folders before root files', () => {
    const repo = makeTree({
      '.claude/rules/naming.md': '# Naming\n',
      'CONTRIBUTING.md': '# Contribuir\n',
    });

    const paths = loadRules({ repo }).sources.map((s) => s.path);

    expect(paths.indexOf('naming.md')).toBeLessThan(paths.indexOf('CONTRIBUTING.md'));
  });

  it('is empty when a repository wrote nothing down', () => {
    expect(loadRules({ repo: makeTree({ 'src/a.cs': 'class A {}\n' }) }).empty).toBe(true);
  });
});

describe('declaredScope', () => {
  it.each([
    ['---\nglobs: **/*.ts\n---\n# Regla', ['**/*.ts']],
    ['---\nglobs: ["src/**/*.vue", "src/**/*.ts"]\n---\n', ['src/**/*.vue', 'src/**/*.ts']],
    ['---\nappliesTo: **/*.cs\n---\n', ['**/*.cs']],
  ])('reads the scope a rule declares about itself', (body, expected) => {
    expect(declaredScope(body)).toEqual(expected);
  });

  it('returns nothing when a rule declares no scope', () => {
    expect(declaredScope('# Regla sin frontmatter\n')).toEqual([]);
  });
});

describe('matchesAny', () => {
  it.each([
    ['**/*.ts', 'src/app/main.ts', true],
    ['**/*.ts', 'main.ts', true],
    ['src/**/*.vue', 'src/components/Card.vue', true],
    ['src/**/*.vue', 'tests/Card.vue', false],
    ['**/*.{ts,vue}', 'src/a.vue', true],
    ['**/*.cs', 'src/a.ts', false],
  ])('%s vs %s -> %s', (glob, path, expected) => {
    expect(matchesAny([glob], [path])).toBe(expected);
  });

  // `globs: a{b` used to emit an unterminated group, and the `RegExp` throw
  // travelled all the way to the runner's catch-all, where a four-line file
  // turned a blocking check into a green "no bloquea". Keeping the rule is the
  // safe direction: reading a convention that did not apply costs budget,
  // dropping one that did applies no rule at all.
  it.each(['a{b', '**/*.{ts', '[', 'a{b,c', '{{{', '**/*.{ts,{tsx'])(
    'never throws on the malformed glob %s',
    (glob) => {
      expect(() => matchesAny([glob], ['src/a.cs'])).not.toThrow();
    },
  );

  // The unclosed brace is read as if it had been closed, which is the reading the
  // author almost certainly meant.
  it('closes an unbalanced brace instead of giving up', () => {
    expect(matchesAny(['src/*.{ts'], ['src/a.ts'])).toBe(true);
    expect(matchesAny(['**/*.{ts,tsx}'], ['src/a.tsx'])).toBe(true);
  });
});

describe('relevance pre-filter', () => {
  const FRONTEND = '---\nglobs: **/*.vue\n---\n# Frontend\nUn componente por archivo.\n';
  const BACKEND = '---\nglobs: **/*.cs\n---\n# Backend\nUn controlador por recurso.\n';
  const ALWAYS = '# General\nNada de secretos en el código.\n';

  it('drops a rule that declares itself out of scope', () => {
    const repo = makeTree({
      '.claude/rules/frontend.md': FRONTEND,
      '.claude/rules/backend.md': BACKEND,
      '.claude/rules/general.md': ALWAYS,
    });

    const rules = loadRules({ repo, touched: ['src/Api/OrderController.cs'] });
    const loaded = rules.sources.map((s) => s.path);

    expect(loaded).toContain('backend.md');
    expect(loaded).toContain('general.md');
    expect(loaded).not.toContain('frontend.md');
  });

  // Out-of-scope is not the same as over budget, and a developer wondering why
  // a convention was not applied needs to be able to tell the two apart.
  it('records the reason, distinct from a budget cut', () => {
    const repo = makeTree({ '.claude/rules/frontend.md': FRONTEND });
    const rules = loadRules({ repo, touched: ['src/a.cs'] });

    expect(rules.omittedSources[0].reason).toContain('fuera de alcance');
    expect(rules.truncated).toBe(false);
    expect(rulesTruncationNote(rules)).toBeNull();
  });

  // Guessing scope from a filename would eventually drop the one rule a pull
  // request violates, and a gate that misses what it was asked to catch is
  // worse than one that reads too much.
  it('keeps a rule that declares no scope, whatever it is called', () => {
    const repo = makeTree({ '.claude/rules/frontend.md': '# Frontend\nUn componente por archivo.\n' });
    const rules = loadRules({ repo, touched: ['src/a.cs'] });

    expect(rules.sources.map((s) => s.path)).toContain('frontend.md');
  });

  it('applies no filter at all when the touched files are unknown', () => {
    const repo = makeTree({ '.claude/rules/frontend.md': FRONTEND });

    expect(loadRules({ repo }).sources).toHaveLength(1);
  });

  it('keeps the frontmatter out of what the model reads', () => {
    const repo = makeTree({ '.claude/rules/frontend.md': FRONTEND });
    const rules = loadRules({ repo, touched: ['src/Card.vue'] });

    expect(rules.text).toContain('Un componente por archivo');
    expect(rules.text).not.toContain('globs:');
  });
});

describe('rulesSourceNotes', () => {
  it('says what was read and what was left out, with the reason', () => {
    const repo = makeTree({
      '.claude/rules/frontend.md': '---\nglobs: **/*.vue\n---\n# Frontend\n',
      '.claude/rules/general.md': '# General\n',
    });

    const notes = rulesSourceNotes(loadRules({ repo, touched: ['src/a.cs'] }));

    expect(notes[0]).toContain('Reglas cargadas (1)');
    expect(notes[0]).toContain('general.md');
    expect(notes[1]).toContain('frontend.md');
    expect(notes[1]).toContain('fuera de alcance');
  });

  it('says nothing about omissions when there are none', () => {
    const repo = makeTree({ '.claude/rules/general.md': '# General\n' });

    expect(rulesSourceNotes(loadRules({ repo, touched: ['src/a.cs'] }))).toHaveLength(1);
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
      checkConfig: { model: 'check/model' },
      repoConfig: { checks: { rules: { model: 'repo/model' } } },
    });

    expect(config.model).toBe('repo/model');
  });

  // `.pr-validator.json` is read from the head checkout, so this is the author of
  // the change deciding whether the check that judges it can fail at all.
  it('refuses a head-side blocking:false', () => {
    const config = resolveConfig({
      check: 'rules',
      checkConfig: { blocking: true },
      repoConfig: { checks: { rules: { blocking: false } } },
    });

    expect(config.blocking).toBe(true);
  });

  it('still lets a repository make a non-blocking check blocking', () => {
    const config = resolveConfig({
      check: 'rules',
      checkConfig: { blocking: false },
      repoConfig: { checks: { rules: { blocking: true } } },
    });

    expect(config.blocking).toBe(true);
  });

  // A budget is a gate control: one character of diff leaves the model nothing
  // to object to, and it answers PASS without printing a failure anywhere.
  it.each([
    ['maxDiffChars', 1],
    ['maxRulesChars', 1],
    ['attempts', 0],
  ])('clamps a head-side %s of %s to its floor', (key, value) => {
    const config = resolveConfig({ check: 'rules', repoConfig: { checks: { rules: { [key]: value } } } });

    expect(config[key]).toBe(BOUNDS[key].min);
  });

  it('clamps an inflated budget to its ceiling', () => {
    const config = resolveConfig({ check: 'rules', repoConfig: { maxDiffChars: 99999999 } });

    expect(config.maxDiffChars).toBe(BOUNDS.maxDiffChars.max);
  });

  it('keeps a budget the repository is entitled to set', () => {
    const config = resolveConfig({ check: 'rules', repoConfig: { maxDiffChars: 20000 } });

    expect(config.maxDiffChars).toBe(20000);
  });

  it('falls back to the default when a budget is not a number', () => {
    const config = resolveConfig({ check: 'rules', repoConfig: { maxDiffChars: 'mucho' } });

    expect(config.maxDiffChars).toBe(VALIDATOR_DEFAULTS.maxDiffChars);
  });
});

describe('gateOverrideNotes', () => {
  // Refusing in silence is its own defect: the repository that asked deserves to
  // read why it did not take effect, and a reviewer deserves to see it tried.
  it('names a refused blocking:false', () => {
    const notes = gateOverrideNotes({ checks: { rules: { blocking: false } } }, 'rules');

    expect(notes[0]).toContain('`blocking: false`');
    expect(notes[0]).toContain('rama base');
  });

  it('names a budget that was clamped', () => {
    expect(gateOverrideNotes({ checks: { rules: { maxDiffChars: 1 } } }, 'rules')[0]).toContain(
      'maxDiffChars: 1',
    );
  });

  it('says nothing about a budget inside its bounds', () => {
    expect(gateOverrideNotes({ maxDiffChars: 20000 }, 'rules')).toEqual([]);
  });

  it('says nothing when the repository configured nothing', () => {
    expect(gateOverrideNotes({}, 'rules')).toEqual([]);
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

// Prompt caching matches a prefix from the very first token. The rules corpus is
// the only block in any of the six prompts that repeats between runs, so it has
// to come before the header — which carries the head SHA and therefore changes on
// every push, diverging the prefix at token zero.
describe('the rules prompt is ordered so caching can work', () => {
  const built = () =>
    rules.buildPrompt({
      diff: { stat: 'x | 1 +', block: '```diff\n+a\n```', truncated: false, empty: false },
      base: 'origin/develop',
      head: 'abc123',
      repo: '.',
      taskId: 1,
      rules: { text: '### naming.md\nPascalCase.', empty: false, sources: [{ path: 'naming.md' }] },
    });

  it('puts the corpus before anything that changes per push', () => {
    const p = built().prompt;

    expect(p.indexOf('Project rules')).toBeLessThan(p.indexOf('Branch:'));
    expect(p.indexOf('Project rules')).toBeLessThan(p.indexOf('Diff'));
  });

  it('starts the prompt with the corpus itself', () => {
    expect(built().prompt.startsWith('## Project rules')).toBe(true);
  });

  it('still carries the branch context and the diff', () => {
    const p = built().prompt;

    expect(p).toContain('abc123');
    expect(p).toContain('PascalCase');
    expect(p).toContain('Diff');
  });
});

describe('cacheOptions', () => {
  // Only `rules` has a stable block above the provider's minimum cacheable
  // prefix. A key on the others would buy nothing and invite the belief it did.
  it('is set for rules on an openai model', () => {
    expect(cacheOptions({ model: 'openai/gpt-5.6-luna', check: 'rules', repo: '.' })).toEqual({
      openai: { promptCacheKey: 'pr-validator:rules:.' },
    });
  });

  it.each(['security', 'quality', 'criteria', 'duplication', 'tests'])(
    'is absent for %s, whose prompt has nothing stable to cache',
    (check) => {
      expect(cacheOptions({ model: 'openai/gpt-5.6-luna', check, repo: '.' })).toBeUndefined();
    },
  );

  it('is absent for a provider that would not know the option', () => {
    expect(cacheOptions({ model: 'minimax/minimax-m3', check: 'rules', repo: '.' })).toBeUndefined();
  });

  it('scopes the key per repository, which is where the prefix repeats', () => {
    const a = cacheOptions({ model: 'openai/x', check: 'rules', repo: '/a' });
    const b = cacheOptions({ model: 'openai/x', check: 'rules', repo: '/b' });

    expect(a.openai.promptCacheKey).not.toBe(b.openai.promptCacheKey);
  });
});

// `failOn` decides which verdicts fail a check, and it is read from the head
// checkout. A head-side `failOn: []` disarmed it, and the only thing that stopped
// that was every renderer honouring the model's own `overall: FAIL` — a
// probabilistic signal propping up a deterministic gate. Now the set can only grow.
describe('failOn can be widened by a repository, never narrowed', () => {
  it('refuses to drop a severity the check ships with', () => {
    const out = resolveConfig({
      check: 'security',
      checkConfig: { failOn: ['high'] },
      repoConfig: { checks: { security: { failOn: [] } } },
    });

    expect(out.failOn).toContain('high');
  });

  it('lets a repository add one', () => {
    const out = resolveConfig({
      check: 'security',
      checkConfig: { failOn: ['high'] },
      repoConfig: { checks: { security: { failOn: ['medium'] } } },
    });

    expect(out.failOn).toEqual(expect.arrayContaining(['high', 'medium']));
  });

  it('does not duplicate what both declare', () => {
    const out = resolveConfig({
      check: 'security',
      checkConfig: { failOn: ['high'] },
      repoConfig: { checks: { security: { failOn: ['high'] } } },
    });

    expect(out.failOn).toEqual(['high']);
  });
});

// Lowering the effort of a blocking check is loosening the gate: it asks the
// reviewer to think less about the thing that decides the merge. Same rule as
// `failOn` — a head-side file may raise it, never lower it.
describe('effort', () => {
  it('defaults to medium when nothing declares one', () => {
    expect(resolveConfig({ check: 'security' }).effort).toBe(DEFAULT_EFFORT);
  });

  it('takes the level the check ships with', () => {
    expect(resolveConfig({ check: 'security', checkConfig: { effort: 'high' } }).effort).toBe('high');
  });

  it('lets a repository raise it', () => {
    const out = resolveConfig({
      check: 'quality',
      checkConfig: { effort: 'low' },
      repoConfig: { checks: { quality: { effort: 'high' } } },
    });

    expect(out.effort).toBe('high');
  });

  it('refuses to let a repository lower it', () => {
    const out = resolveConfig({
      check: 'security',
      checkConfig: { effort: 'high' },
      repoConfig: { checks: { security: { effort: 'low' } } },
    });

    expect(out.effort).toBe('high');
  });

  it('lets a repository raise a check to max', () => {
    const out = resolveConfig({
      check: 'quality',
      checkConfig: { effort: 'medium' },
      repoConfig: { checks: { quality: { effort: 'max' } } },
    });

    expect(out.effort).toBe('max');
  });

  it('refuses to lower a max check', () => {
    const out = resolveConfig({
      check: 'security',
      checkConfig: { effort: 'max' },
      repoConfig: { checks: { security: { effort: 'high' } } },
    });

    expect(out.effort).toBe('max');
  });

  // A typo must not silently move a blocking check to a level nobody chose.
  it.each(['maximum', 'xhigh', '', 'HIGH', 42])('ignores the unrecognised value %s', (bad) => {
    const out = resolveConfig({
      check: 'security',
      checkConfig: { effort: 'medium' },
      repoConfig: { checks: { security: { effort: bad } } },
    });

    expect(out.effort).toBe('medium');
  });

  it('ships the checks with the levels the cost study recommended', () => {
    const at = (c) => resolveConfig({ check: c, checkConfig: getCheck(c).config }).effort;

    expect([at('security'), at('criteria')]).toEqual(['max', 'max']);
    expect([at('quality'), at('rules')]).toEqual(['medium', 'medium']);
    expect([at('duplication'), at('tests')]).toEqual(['low', 'low']);
  });
});

describe('effortOptions translates per provider', () => {
  it.each([
    ['openai/gpt-5.6-luna', 'openai'],
    ['xai/grok-4.5', 'xai'],
  ])('%s takes a word', (model, key) => {
    expect(effortOptions({ model, effort: 'high' })).toEqual({ [key]: { reasoningEffort: 'high' } });
  });

  it('google takes a token budget', () => {
    const out = effortOptions({ model: 'google/gemini-3.6-flash', effort: 'low' });

    expect(out.google.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
  });

  it('anthropic takes enabled plus a budget', () => {
    const out = effortOptions({ model: 'anthropic/claude-sonnet-5', effort: 'medium' });

    expect(out.anthropic.thinking.type).toBe('enabled');
  });

  // Neither family has a rung above `high`; sending the literal `max` would be
  // a rejected request, which on a merge gate reads as an outage.
  it.each([
    ['openai/gpt-5.6-luna', 'openai'],
    ['xai/grok-4.5', 'xai'],
  ])('%s resolves max down to its own top rung', (model, key) => {
    expect(effortOptions({ model, effort: 'max' })).toEqual({ [key]: { reasoningEffort: 'high' } });
  });

  // Its scale really does have a rung above `high`, and it is where the numbers
  // Artificial Analysis publishes for this model were measured.
  it('deepseek keeps max as a literal, with thinking switched on', () => {
    expect(effortOptions({ model: 'deepseek/deepseek-v4-pro', effort: 'max' })).toEqual({
      deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'max' },
    });
  });

  it('deepseek asks for high explicitly', () => {
    expect(effortOptions({ model: 'deepseek/deepseek-v4-pro', effort: 'high' })).toEqual({
      deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'high' },
    });
  });

  // `low` and `medium` are raised to `high` server-side, so asking for them
  // literally would make the cheap checks cost what the expensive ones cost.
  it.each(['low', 'medium'])('deepseek takes %s as adaptive, not as a floor', (effort) => {
    expect(effortOptions({ model: 'deepseek/deepseek-v4-pro', effort })).toEqual({
      deepseek: { thinking: { type: 'adaptive' } },
    });
  });

  it('every level maps to something for every provider it knows', () => {
    for (const model of ['openai/x', 'xai/x', 'google/x', 'anthropic/x', 'deepseek/x']) {
      for (const effort of EFFORT_LEVELS) {
        const out = effortOptions({ model, effort });

        expect(out, `${model} at ${effort}`).toBeDefined();
        // A budget provider given an effort with no entry would send
        // `thinkingBudget: undefined`, which is a silently wrong request.
        expect(JSON.stringify(out), `${model} at ${effort}`).not.toContain('null');
      }
    }
  });

  // Sending an option a provider does not know risks a rejected request, and a
  // rejected request on a merge gate is worse than the model's own default.
  it('says nothing for a provider it has no mapping for', () => {
    expect(effortOptions({ model: 'minimax/minimax-m3', effort: 'high' })).toBeUndefined();
  });

  it('says nothing for an effort it does not recognise', () => {
    expect(effortOptions({ model: 'openai/x', effort: 'xhigh' })).toBeUndefined();
  });
});

describe('providerOptionsFor merges cache and effort under one provider key', () => {
  it('carries both for the rules check on openai', () => {
    const out = providerOptionsFor({
      model: 'openai/gpt-5.6-luna',
      check: 'rules',
      repo: '.',
      effort: 'medium',
    });

    expect(out.openai.promptCacheKey).toContain('rules');
    expect(out.openai.reasoningEffort).toBe('medium');
  });

  it('carries only the effort for a check with nothing to cache', () => {
    const out = providerOptionsFor({ model: 'openai/x', check: 'security', effort: 'high' });

    expect(out).toEqual({ openai: { reasoningEffort: 'high' } });
  });

  it('is undefined when neither applies', () => {
    expect(providerOptionsFor({ model: 'minimax/m3', check: 'security', effort: 'high' })).toBeUndefined();
  });
});
