// Run ONE check and write its verdict.
//
// One check per process on purpose: each prompt stays small and focused, each
// check is its own GitHub status check, and a failure in one cannot take the
// others down.
//
// The process ALWAYS exits 0. A blocking failure is reported through the
// `blocking-failure` action output, and the workflow turns that into red in a
// later step. Exiting non-zero here would kill the job before the verdict is
// uploaded, and the consolidated comment would silently lose that check.

import { writeFileSync } from 'node:fs';
import { EFFORT_LEVELS, resolveConfig } from './context/config.mjs';
import { loadRepoConfig, perCheckSettings } from './context/repo-config.mjs';
import { buildContext } from './context/build.mjs';
import { fetchTask } from './context/tasks-api.mjs';
import { getCheck, UnknownCheckError, listChecks } from './checks/registry.mjs';
import { contextNotes, isContentFailure, shortCircuit } from './checks/short-circuit.mjs';
import { callGateway, GatewayError, tokenUsage } from './gateway.mjs';
import {
  STATUS,
  isBlockingFailure,
  makeVerdict,
  skippedVerdict,
  toolErrorVerdict,
  unreviewableVerdict,
} from './report/verdict.mjs';

// Re-exported: it moved next to the other pre-model decisions, and callers that
// import it from the runner keep working.
export { isContentFailure };

/** Read the runtime inputs from the environment the composite action sets up. */
export function readInputs(env = process.env) {
  return {
    check: env.INPUT_CHECK || env.CHECK || '',
    base: env.INPUT_BASE || env.BASE || 'origin/develop',
    head: env.INPUT_HEAD || env.HEAD_SHA || 'HEAD',
    repo: env.INPUT_REPO || '.',
    outFile: env.INPUT_OUT || 'verdict.json',
    headRef: env.PR_HEAD_REF || '',
    prTitle: env.PR_TITLE || '',
    prBody: env.PR_BODY || '',
    isFork: env.PR_IS_FORK === 'true',
    model: env.INPUT_MODEL || env.PR_VALIDATOR_MODEL || '',
    configPath: env.INPUT_CONFIG_PATH || '.pr-validator.json',
  };
}

/**
 * Provider options that make prompt caching possible, or nothing when it cannot be.
 *
 * Only `rules` carries a block big enough to cache: its corpus is 11–12k tokens of
 * text that is identical between runs. The other five checks have no stable region
 * above the provider's minimum cacheable prefix — their prompts are a system prompt
 * of a few hundred tokens followed by a diff that changes with every push — so a
 * cache key there would buy nothing and only invite the belief that it did.
 *
 * The key is per repository and per check because that is exactly the scope over
 * which the prefix repeats. Sharing one key across checks would be worse than none:
 * their system prompts differ, so the prefixes diverge at the first token anyway.
 *
 * @returns {object|undefined} `providerOptions` for the SDK, or undefined.
 */
export function cacheOptions({ model = '', check = '', repo = '' } = {}) {
  if (check !== 'rules') return undefined;

  const provider = String(model).split('/')[0];
  // `promptCacheKey` is an OpenAI-family option. Sending it to a provider that
  // does not know it is not worth the risk of a rejected request.
  if (provider !== 'openai') return undefined;

  return { openai: { promptCacheKey: `pr-validator:${check}:${repo}` } };
}

/**
 * Reasoning-budget tokens per level, for the providers that take a number instead
 * of a word. Deliberately modest at the top: `high` should mean "think properly",
 * not "spend without a ceiling" on a gate that runs on every push.
 */
const THINKING_BUDGET = { low: 1024, medium: 4096, high: 12288, max: 24576 };

/**
 * Translate an effort level into whatever the model's provider actually accepts.
 *
 * The key is not uniform across families, so it is derived from the model id:
 * `openai/gpt-5.6-luna` and `xai/*` take a word, Google takes a token budget,
 * Anthropic takes an enabled-plus-budget object, DeepSeek takes a word plus an
 * explicit thinking flag. A provider we do not have a mapping for gets nothing —
 * sending an option a provider does not know risks a rejected request, and a
 * rejected request on a merge gate is worse than running at the model's own
 * default.
 *
 * Neither is the *scale* uniform, which is why the levels are translated rather
 * than forwarded: the same `max` means a real top rung on DeepSeek and `high`
 * everywhere else.
 *
 * @returns {object|undefined} `providerOptions`, or undefined when unmappable.
 */
export function effortOptions({ model = '', effort = '' } = {}) {
  if (!EFFORT_LEVELS.includes(effort)) return undefined;

  const provider = String(model).split('/')[0];
  const budget = THINKING_BUDGET[effort];

  switch (provider) {
    case 'openai':
    case 'xai':
      // Neither family has a rung above `high`, so `max` resolves to it. Sending
      // the literal would be a rejected request, and a rejected request on a
      // merge gate reads as an outage — the check goes green with a warning.
      return { [provider]: { reasoningEffort: effort === 'max' ? 'high' : effort } };
    case 'google':
      return { google: { thinkingConfig: { thinkingBudget: budget } } };
    case 'anthropic':
      return { anthropic: { thinking: { type: 'enabled', budgetTokens: budget } } };
    case 'deepseek':
      // Two things this provider does differently. Thinking is off by default
      // and `reasoningEffort` alone does not switch it on, so the flag has to
      // travel with it or the option is silently inert. And its own scale is
      // only `high` and `max`: `low` and `medium` are raised to `high`
      // server-side, which would make the two cheap checks cost what the
      // expensive ones cost. `adaptive` is the honest translation of a low
      // level here — it lets the model spend only where the question warrants
      // it, instead of paying for a floor we did not ask for.
      return effort === 'high' || effort === 'max'
        ? { deepseek: { thinking: { type: 'enabled' }, reasoningEffort: effort } }
        : { deepseek: { thinking: { type: 'adaptive' } } };
    default:
      return undefined;
  }
}

/** Everything this run wants to tell the provider, merged per provider key. */
export function providerOptionsFor({ model, check, repo, effort } = {}) {
  const parts = [cacheOptions({ model, check, repo }), effortOptions({ model, effort })].filter(
    Boolean,
  );
  if (!parts.length) return undefined;

  const merged = {};
  for (const part of parts) {
    for (const [provider, options] of Object.entries(part)) {
      merged[provider] = { ...(merged[provider] ?? {}), ...options };
    }
  }
  return merged;
}

export async function runCheck({ inputs, env = process.env, log = console.error } = {}) {
  const name = inputs.check;

  let check;
  try {
    check = getCheck(name);
  } catch (err) {
    if (err instanceof UnknownCheckError) {
      log(`::error::${err.message}`);
      return toolErrorVerdict({
        check: name || 'unknown',
        title: name || 'Check desconocido',
        error: `Check "${name}" no existe. Disponibles: ${listChecks().join(', ')}.`,
      });
    }
    throw err;
  }

  const repoConfig = loadRepoConfig({ repo: inputs.repo, configPath: inputs.configPath });

  const config = resolveConfig({
    check: name,
    checkConfig: check.config,
    // `checks` doubles as the run list, so per-check settings may live under
    // either key. Normalising here keeps `resolveConfig` unaware of the file's
    // shape and its precedence rules untouched.
    repoConfig: { ...repoConfig.config, checks: perCheckSettings(repoConfig.config) },
    inputs: inputs.model ? { model: inputs.model } : {},
  });

  // Before the context is built, not after. A fork pull request skips every AI
  // check in green, so building the context first meant an outside contributor
  // still paid for the repository-wide symbol index and the scoring pass — the
  // expensive half of a run whose result was discarded.
  if (inputs.isFork) {
    return skippedVerdict({
      check: name,
      title: check.meta.title,
      reason:
        'PR desde un fork: GitHub no entrega secrets a workflows de forks, así que los checks de IA no pueden ejecutarse. No bloquea.',
    });
  }

  let ctx;
  try {
    ctx = await buildContext({ check, inputs, config, log, fetchTask });
  } catch (err) {
    // Not every failure here is somebody else's outage. A glob the branch wrote,
    // a diff too large to buffer, a file that cannot be read — those are
    // properties of the change under review, and answering "no bloquea" to them
    // means the gate waved through a pull request it never looked at.
    if (isContentFailure(err)) {
      log(`::error::${name}: no se pudo construir el contexto: ${err.message}`);
      return unreviewableVerdict({
        check: name,
        title: check.meta.title,
        error: err.message,
        blocking: config.blocking,
        meta: { model: config.model },
      });
    }
    return toolErrorVerdict({ check: name, title: check.meta.title, error: err.message });
  }

  const early = shortCircuit({ name, check, inputs, ctx });
  if (early) return early;

  const notes = contextNotes(ctx, repoConfig, name);

  // From here on the context exists, so any tool error still reports what was
  // loaded and what had to be cut. Truncation is information the developer
  // needs whether or not the model answered.
  const toolError = (error) =>
    toolErrorVerdict({
      check: name,
      title: check.meta.title,
      error,
      meta: { model: config.model },
      notes,
    });

  if (ctx.diff?.empty && name !== 'criteria') {
    return skippedVerdict({
      check: name,
      title: check.meta.title,
      reason: 'El PR no introduce cambios respecto a la rama base.',
    });
  }

  let built;
  try {
    built = check.buildPrompt(ctx);
  } catch (err) {
    return toolError(err.message);
  }

  if (!env.AI_GATEWAY_API_KEY) {
    return toolError('AI_GATEWAY_API_KEY no está definido en el repositorio consumidor.');
  }

  // Required, with no fallback: the validator does not pick a model on the
  // repository's behalf.
  if (!config.model) {
    return toolError(
      'PR_VALIDATOR_MODEL no está definido en el repositorio consumidor. ' +
        'Configúralo como variable de Actions, o fija `model` en `.pr-validator.json`.',
    );
  }

  let result;
  try {
    result = await callGateway({
      model: config.model,
      system: built.system,
      prompt: built.prompt,
      attempts: config.attempts,
      accept: check.accept,
      providerOptions: providerOptionsFor({
        model: config.model,
        check: name,
        repo: inputs.repo,
        effort: config.effort,
      }),
      onRetry: ({ attempt, attempts, reason }) =>
        log(`attempt ${attempt}/${attempts} (${config.model}, ${name}): ${reason} — retrying`),
    });
  } catch (err) {
    if (err instanceof GatewayError) {
      return toolError(err.message);
    }
    throw err;
  }

  const rendered = check.render(result.parsed, ctx);
  if (!rendered) {
    return toolError(`El modelo ${config.model} devolvió un veredicto con forma inesperada.`);
  }

  return makeVerdict({
    check: name,
    title: check.meta.title,
    status: rendered.overall === 'FAIL' ? STATUS.FAIL : STATUS.PASS,
    blocking: config.blocking,
    summary: result.parsed.summary ?? '',
    rows: rendered.rows,
    details: rendered.details,
    // A renderer may add a note of its own — the model disagreeing with the
    // deterministic verdict is reported, not dropped.
    notes: rendered.note ? [...notes, rendered.note] : notes,
    emptyMessage: rendered.emptyMessage ?? '',
    meta: {
      model: config.model,
      taskId: ctx.taskId,
      counts: rendered.counts,
      tokens: result.usage?.totalTokens ?? null,
      // Cache hits/writes and reasoning tokens, when the provider reports them.
      // Kept so the cost of a run can be answered from our own artifacts instead
      // of from a dashboard that cannot be broken down per check.
      usage: tokenUsage(result.usage),
      attempt: result.attempt,
    },
  });
}

/** Append a `key=value` pair to the GitHub Actions output file, when present. */
function setOutput(key, value, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  writeFileSync(file, `${key}=${value}\n`, { flag: 'a' });
}

export async function main(env = process.env) {
  const inputs = readInputs(env);
  const verdict = await runCheck({ inputs, env });

  writeFileSync(inputs.outFile, JSON.stringify(verdict, null, 2), 'utf8');

  setOutput('status', verdict.status, env);
  setOutput('blocking-failure', String(isBlockingFailure(verdict)), env);

  if (verdict.status === STATUS.TOOL_ERROR) {
    console.error(`::warning::${verdict.check}: ${verdict.notes[0] ?? 'error de herramienta'}`);
  }
  console.error(`${verdict.check}: ${verdict.status}${verdict.blocking ? '' : ' (no bloquea)'}`);

  // Always 0 — see the note at the top of this file.
  return 0;
}
