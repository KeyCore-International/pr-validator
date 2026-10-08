// `render`: turn a reviewer's answer into the verdict CI would have written.
//
// The answer goes through the check's own `accept` and `render`, and the result
// through `makeVerdict`, with the notes and configuration `prompts` saved for
// that check. The verdict file therefore has the shape CI produces and is read
// by the same tools.
//
// A check that `prompts` resolved without a model has nothing to render: its
// saved verdict is copied as it is, so a caller can render every check the same
// way.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCheck, listChecks } from '../checks/registry.mjs';
import { makeVerdict, STATUS } from '../report/verdict.mjs';
import { UsageError } from './errors.mjs';
import { stableStringify } from './json.mjs';

/**
 * Parse a reviewer's answer: a JSON object, optionally inside a single
 * ```json fence. Anything else is refused rather than guessed at — locally the
 * answer can simply be asked for again.
 */
export function parseAnswer(text) {
  let body = String(text ?? '').trim();
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  if (fence) body = fence[1].trim();
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read ${what} ${path}: ${err.message}`);
  }
}

/**
 * Build the verdict for one check from its answer and its saved context.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {object} opts.parsed  The reviewer's answer.
 * @param {object} opts.saved   `<check>.ctx.json` written by `prompts`.
 * @param {string} [opts.model] Label for `meta.model`.
 * @returns {object} the verdict.
 * @throws {UsageError} when the answer does not have the check's shape.
 */
export function renderVerdict({ name, parsed, saved, model = '' }) {
  const check = getCheck(name);
  if (typeof check.accept === 'function' && !check.accept(parsed)) {
    throw new UsageError(`the answer for "${name}" does not have the shape this check expects`);
  }

  const ctx = {
    config: saved.config ?? {},
    taskId: saved.taskId ?? null,
    taskRef: saved.taskRef ?? null,
    task: saved.task ?? null,
  };
  const rendered = check.render(parsed, ctx);
  if (!rendered) {
    throw new UsageError(`the answer for "${name}" could not be rendered`);
  }

  const notes = Array.isArray(saved.notes) ? saved.notes : [];
  return makeVerdict({
    check: name,
    title: check.meta.title,
    status: rendered.overall === 'FAIL' ? STATUS.FAIL : STATUS.PASS,
    blocking: saved.config?.blocking ?? check.config?.blocking,
    summary: parsed.summary ?? '',
    rows: rendered.rows,
    details: rendered.details,
    notes: rendered.note ? [...notes, rendered.note] : notes,
    emptyMessage: rendered.emptyMessage ?? '',
    meta: {
      model: model || saved.config?.model || '',
      taskId: saved.taskId ?? null,
      counts: rendered.counts,
      tokens: null,
      usage: {},
      attempt: 1,
    },
  });
}

/**
 * Run `render` for one check and write `<out>/verdicts/<check>.json`.
 *
 * @param {object} opts
 * @param {string} opts.out
 * @param {string} opts.check
 * @param {string|null} [opts.inFile]  The answer. Optional when `prompts` skipped the check.
 * @param {string} [opts.model]
 * @returns {object} the verdict written.
 */
export function writeVerdict({ out, check: name, inFile = null, model = '' }) {
  if (!name) throw new UsageError('render needs --check');
  if (!listChecks().includes(name)) {
    throw new UsageError(`unknown check "${name}". Available: ${listChecks().join(', ')}.`);
  }

  const promptsDir = join(out, 'prompts');
  const skipFile = join(promptsDir, `${name}.skip.json`);
  const ctxFile = join(promptsDir, `${name}.ctx.json`);

  let verdict;
  if (existsSync(skipFile)) {
    if (inFile) {
      throw new UsageError(`"${name}" was resolved without a model (${skipFile}); there is no answer to render`);
    }
    verdict = readJson(skipFile, 'skip verdict');
  } else {
    if (!existsSync(ctxFile)) {
      throw new UsageError(`no prompt context for "${name}" in ${promptsDir}: run \`prompts\` first`);
    }
    if (!inFile) throw new UsageError('render needs --in <answer.json>');

    let text;
    try {
      text = readFileSync(inFile, 'utf8');
    } catch (err) {
      throw new UsageError(`cannot read the answer ${inFile}: ${err.message}`);
    }
    const parsed = parseAnswer(text);
    if (!parsed) throw new UsageError(`the answer ${inFile} is not a JSON object`);

    verdict = renderVerdict({ name, parsed, saved: readJson(ctxFile, 'prompt context'), model });
  }

  const dir = join(out, 'verdicts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), stableStringify(verdict), 'utf8');
  return verdict;
}
