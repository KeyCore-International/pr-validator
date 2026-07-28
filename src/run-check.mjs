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
import { buildDiff, ensureBaseRef, truncationNote } from './context/diff.mjs';
import { loadRules, rulesTruncationNote } from './context/rules.mjs';
import { resolveConfig } from './context/config.mjs';
import { resolveTaskRef } from './context/task-ref.mjs';
import { fetchTask } from './context/tasks-api.mjs';
import { getCheck, UnknownCheckError, listChecks } from './checks/registry.mjs';
import { callGateway, GatewayError } from './gateway.mjs';
import {
  STATUS,
  isBlockingFailure,
  makeVerdict,
  skippedVerdict,
  toolErrorVerdict,
} from './report/verdict.mjs';
import { noRulesVerdict } from './checks/rules/render.mjs';

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
  };
}

/** Assemble only the context this check declared it needs. */
async function buildContext({ check, inputs, config, log }) {
  const needs = new Set(check.meta.contextNeeds);
  const ctx = {
    base: inputs.base,
    head: inputs.head,
    repo: inputs.repo,
    taskId: null,
    config,
  };

  if (needs.has('diff')) {
    ensureBaseRef(inputs.repo, inputs.base);
    ctx.diff = buildDiff({
      repo: inputs.repo,
      base: inputs.base,
      head: inputs.head,
      maxChars: config.maxDiffChars,
    });
  }

  if (needs.has('rules')) {
    ctx.rules = loadRules({ repo: inputs.repo, maxChars: config.maxRulesChars });
  }

  if (needs.has('task')) {
    const ref = resolveTaskRef({
      headRef: inputs.headRef,
      prTitle: inputs.prTitle,
      prBody: inputs.prBody,
    });
    ctx.taskRef = ref;
    ctx.taskId = ref.taskId;

    if (ref.mode === 'task' && ref.taskId) {
      try {
        ctx.task = await fetchTask(ref.taskId);
      } catch (err) {
        log(`task fetch failed for #${ref.taskId}: ${err.message}`);
        // The PR-body block is the documented fallback for an unreachable
        // task manager.
        ctx.task = ref.criteriaBlock ? { criteriaBlock: ref.criteriaBlock } : null;
        ctx.taskFetchError = err.message;
      }
    } else if (ref.criteriaBlock) {
      ctx.task = { criteriaBlock: ref.criteriaBlock };
    }
  }

  return ctx;
}

/** Cases where a check legitimately produces a verdict without calling a model. */
function shortCircuit({ name, check, inputs, ctx }) {
  if (inputs.isFork) {
    return skippedVerdict({
      check: name,
      title: check.meta.title,
      reason:
        'PR desde un fork: GitHub no entrega secrets a workflows de forks, así que los checks de IA no pueden ejecutarse. No bloquea.',
    });
  }

  if (name === 'rules' && ctx.rules?.empty) {
    const base = noRulesVerdict(ctx.rules);
    return skippedVerdict({
      check: name,
      title: check.meta.title,
      reason: base.emptyMessage,
    });
  }

  if (check.meta.contextNeeds.includes('task')) {
    const mode = ctx.taskRef?.mode;

    if (mode === 'exempt') {
      return skippedVerdict({
        check: name,
        title: check.meta.title,
        reason: `La rama \`${inputs.headRef}\` está exenta de la convención de tareas. No hay criterios que validar.`,
      });
    }

    if (mode === 'invalid') {
      return makeVerdict({
        check: name,
        title: check.meta.title,
        status: STATUS.FAIL,
        blocking: true,
        summary: 'No se pudo identificar la tarea del PR.',
        details: [
          {
            id: 'ref',
            heading: 'Referencia de tarea ausente',
            body:
              `La rama \`${inputs.headRef}\` no sigue la convención \`feature/<id>-<slug>\` y el PR no aporta el id de la tarea. ` +
              'Sin id no se pueden validar los criterios de aceptación. Renombra la rama o incluye el id de la tarea. ' +
              'Prefijos exentos: `chore/`, `hotfix/`, `release/`.',
          },
        ],
      });
    }

    if (!ctx.task) {
      return skippedVerdict({
        check: name,
        title: check.meta.title,
        reason:
          `No se pudo obtener la tarea #${ctx.taskId} del gestor de tareas` +
          (ctx.taskFetchError ? ` (${ctx.taskFetchError})` : '') +
          ', y el PR no incluye un bloque `criteria` de respaldo. Revisa la configuración de integración del repositorio. No bloquea.',
      });
    }
  }

  return null;
}

/** Notes that belong on the verdict regardless of outcome (AC-6, AC-22, AC-23). */
function contextNotes(ctx) {
  const notes = [];
  if (ctx.diff) {
    const note = truncationNote(ctx.diff);
    if (note) notes.push(note);
  }
  if (ctx.rules) {
    const note = rulesTruncationNote(ctx.rules);
    if (note) notes.push(note);
    if (ctx.rules.sources.length) {
      notes.push(
        `Reglas cargadas (${ctx.rules.sources.length}): ${ctx.rules.sources.map((s) => s.path).join(', ')}.`,
      );
    }
  }
  return notes;
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

  const config = resolveConfig({
    check: name,
    checkConfig: check.config,
    inputs: inputs.model ? { model: inputs.model } : {},
  });

  let ctx;
  try {
    ctx = await buildContext({ check, inputs, config, log });
  } catch (err) {
    return toolErrorVerdict({ check: name, title: check.meta.title, error: err.message });
  }

  const early = shortCircuit({ name, check, inputs, ctx });
  if (early) return early;

  const notes = contextNotes(ctx);

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

  let result;
  try {
    result = await callGateway({
      model: config.model,
      system: built.system,
      prompt: built.prompt,
      attempts: config.attempts,
      accept: check.accept,
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
    notes,
    emptyMessage: rendered.emptyMessage ?? '',
    meta: {
      model: config.model,
      taskId: ctx.taskId,
      counts: rendered.counts,
      tokens: result.usage?.totalTokens ?? null,
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
