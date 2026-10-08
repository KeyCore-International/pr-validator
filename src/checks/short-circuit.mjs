// What a check can decide before any model is called.
//
// Kept apart from the runner so that every path that builds a check's context —
// the CI runner and the local mode — skips, notes and refuses in exactly the
// same way. Two copies of these rules would drift, and a local run that skips
// what CI judges (or the reverse) is a local run nobody can trust.

import { truncationNote } from '../context/diff.mjs';
import { rulesSourceNotes, rulesTruncationNote } from '../context/rules.mjs';
import { gateOverrideNotes } from '../context/config.mjs';
import { skippedVerdict, unreviewableVerdict } from '../report/verdict.mjs';
import { noRulesVerdict } from './rules/render.mjs';

/**
 * Was this failure caused by the change under review, rather than by the world?
 *
 * Deliberately a whitelist. Guessing the other way — treating anything unknown
 * as the author's fault — would block merges on genuine outages, which is the
 * failure mode this project cares most about avoiding.
 */
export function isContentFailure(err) {
  if (!err) return false;
  // Set by whoever threw, which is the only party that knows.
  if (err.contentFailure === true) return true;
  // A pattern the branch wrote that does not compile. Belt and braces: the glob
  // reader no longer lets this escape, but a new caller might.
  if (err instanceof SyntaxError) return true;
  return false;
}

/** Cases where a check legitimately produces a verdict without calling a model. */
export function shortCircuit({ name, check, inputs, ctx }) {
  // The fork case is handled by `runCheck` before the context is built — see the
  // comment there. It is deliberately not repeated here.

  // A change that only edits prose has nothing for a code reviewer to say. The
  // skip is declared rather than silent: the developer sees why the check did
  // not run, instead of wondering whether it was broken.
  if (check.meta.requiresCode && ctx.files && !ctx.files.hasCode && !ctx.diff?.empty) {
    return skippedVerdict({
      check: name,
      title: check.meta.title,
      reason:
        `El diff no toca archivos de código (${ctx.files.nonCode.length} archivo(s) de documentación o binarios). ` +
        'No hay nada que revisar en este check.',
    });
  }

  // A repository with no test suite does not fail coverage — there is nothing
  // to cross against. And when every new symbol is already mentioned by a test,
  // there is no question left for a model to answer.
  if (ctx.coverage) {
    if (!ctx.coverage.hasTestSuite) {
      return skippedVerdict({
        check: name,
        title: check.meta.title,
        reason:
          'El repositorio no tiene archivos de test que cruzar. No hay cobertura que exigir ' +
          'hasta que exista una suite.',
      });
    }

    if (!ctx.coverage.orphans.length) {
      // Symbols without logic (DTOs, getters, flat mappers, pure delegation) are
      // never crossed. When some were left out that way the skip must say so,
      // rather than claim the suite mentions them.
      const exempt = ctx.coverage.exempt?.length ?? 0;
      const covered = ctx.coverage.covered?.length ?? 0;
      const reason = exempt
        ? `Ningún símbolo público con lógica del PR queda sin test: ${covered} aparecen en la suite ` +
          `(${ctx.coverage.testFileCount} archivos de test) y ${exempt} no tienen lógica que exija uno ` +
          '(DTOs, getters, mapeos simples o delegación).'
        : `Los símbolos públicos que introduce el PR ya aparecen en la suite (${ctx.coverage.testFileCount} archivos de test).`;
      return skippedVerdict({ check: name, title: check.meta.title, reason });
    }
  }

  // Nothing cleared the similarity threshold, which is the ordinary outcome.
  // Skipping here is what keeps the check cheap: most pull requests never pay
  // for a model call at all.
  if (ctx.duplication && !ctx.duplication.findings.length) {
    const dup = ctx.duplication;
    const suppressed = dup.suppressed?.length ?? 0;
    let reason;
    if (dup.introduced) {
      reason = `Ninguno de los ${dup.introduced} símbolos que introduce el PR se parece a los ${dup.indexed} ya indexados.`;
    } else if (suppressed) {
      // Not "nothing comparable": something was, and an ignore took it out.
      reason =
        `El PR no deja símbolos que comparar: ${suppressed} símbolo(s) tocado(s) quedaron excluidos por un ` +
        '`pr-validator-ignore duplication` que ya estaba en la rama base.';
    } else {
      reason = 'El PR no introduce símbolos comparables con el resto del repositorio.';
    }
    // A skip carries only its reason, so what the comparison left out or cut
    // goes into it; otherwise a skip would hide what a run with findings declares.
    return skippedVerdict({
      check: name,
      title: check.meta.title,
      reason: [reason, ...duplicationNotes(dup)].join(' '),
    });
  }

  // Nothing to judge against. `empty` means the repository wrote nothing down;
  // an empty `text` also covers a corpus that ended up with no section for a
  // reason — every file refused by the read guard, or dropped by scope or
  // budget. `noRulesVerdict` is what says which of those happened, so a corpus
  // that vanished behind symlinks never reads as "sin reglas declaradas".
  if (name === 'rules' && ctx.rules && !ctx.rules.text) {
    const base = noRulesVerdict(ctx.rules);
    // A corpus the budget threw away is not an absence of rules, and skipping it
    // green would publish a reason that is untrue while the rule files sit in the
    // tree. The budget is settable from the branch under review, which is what
    // made the green skip buyable.
    if (base.overall === 'FAIL') {
      return unreviewableVerdict({
        check: name,
        title: check.meta.title,
        error: base.emptyMessage,
        blocking: ctx.config?.blocking !== false,
      });
    }
    return skippedVerdict({
      check: name,
      title: check.meta.title,
      reason: base.emptyMessage,
    });
  }

  if (check.meta.contextNeeds.includes('task')) {
    const mode = ctx.taskRef?.mode;

    // No reference is not a violation — it is a check with nothing to judge
    // against. This is the only outcome for a pull request that carries no
    // task, and it is green on purpose: the naming convention is a shortcut,
    // not a gate.
    if (mode === 'none') {
      return skippedVerdict({
        check: name,
        title: check.meta.title,
        reason:
          `El PR no referencia ninguna tarea, ni en la rama \`${inputs.headRef}\`, ni en el título, ni en el cuerpo. ` +
          'No hay criterios que validar. Para que este check evalúe, incluye el id de la tarea ' +
          'en el nombre de la rama (`<id>-slug`) o en el título del PR (`#<id>`).',
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
export function contextNotes(ctx, repoConfig, check = '') {
  const notes = [...(repoConfig?.notes ?? [])];
  // What the branch asked for and did not get. Refusing in silence would leave a
  // repository debugging a setting that looked accepted.
  notes.push(...gateOverrideNotes(repoConfig?.config ?? {}, check));
  // The author wrote acceptance criteria in the PR body and the real task was
  // reachable, so the fence was ignored. Saying so is the difference between a
  // verdict a reviewer can trust and one they cannot audit.
  if (ctx.criteriaBlockIgnored) {
    notes.push(
      'El cuerpo del PR incluye un bloque `criteria`, pero se obtuvo la tarea del gestor: ' +
        'se evaluaron los criterios de la tarea, no los del cuerpo. El bloque solo se usa ' +
        'cuando la tarea no se puede obtener.',
    );
  }
  if (ctx.diff) {
    const note = truncationNote(ctx.diff);
    if (note) notes.push(note);
  }
  if (ctx.rules) {
    const note = rulesTruncationNote(ctx.rules);
    if (note) notes.push(note);
    notes.push(...rulesSourceNotes(ctx.rules));
  }
  if (ctx.duplication) notes.push(...duplicationNotes(ctx.duplication));
  return notes;
}

/** Entries listed per note; the rest are counted. */
const MAX_LISTED = 10;

function listSymbols(entries, withReason) {
  const shown = entries.slice(0, MAX_LISTED).map((entry) => {
    const where = `\`${entry.path}:${entry.line}\` ${entry.name}`;
    // The reason is text from the repository; one line of it, whatever it held.
    const reason = String(entry.reason ?? '').replace(/\s+/g, ' ').trim();
    return withReason && reason ? `${where} (motivo: "${reason}")` : where;
  });
  const rest = entries.length - shown.length;
  return shown.join('; ') + (rest > 0 ? `; y ${rest} más` : '');
}

/**
 * What the duplication comparison left out or cut, as notes.
 *
 * Every ceiling this check can hit is declared, and so is every symbol an
 * inline ignore took out or failed to take out. A comparison that stopped
 * early, dropped its weakest pairs or skipped a suppressed symbol and said
 * nothing would read as "nothing here duplicates anything".
 *
 * @param {object} dup the `buildDuplicationContext` result
 * @returns {string[]}
 */
export function duplicationNotes(dup) {
  const notes = [];
  if (!dup) return notes;

  if (dup.indexTruncated) {
    notes.push(
      `El índice de símbolos del repositorio se truncó: se comparó contra ${dup.indexed} ` +
        'símbolos, no contra todos. La revisión de duplicación es parcial.',
    );
  }
  if (dup.comparisonTruncated) {
    notes.push(
      'La comparación de duplicación agotó su presupuesto de tiempo y se detuvo antes de ' +
        'revisar todos los símbolos que introduce el PR. La revisión es parcial.',
    );
  }

  const candidates = dup.truncation?.candidates ?? 0;
  const pairs = dup.truncation?.pairs ?? 0;
  if (candidates > 0 || pairs > 0) {
    const parts = [];
    if (candidates > 0) {
      parts.push(`${candidates} candidato(s) por encima del tope por símbolo (3, o 5 si el símbolo es público)`);
    }
    if (pairs > 0) parts.push(`${pairs} par(es) por encima del tope de pares por ejecución`);
    notes.push(
      `La comparación de duplicación recortó ${parts.join(' y ')}. Se descartaron los más débiles: ` +
        'la revisión cubre solo los pares más fuertes.',
    );
  }

  const suppressed = dup.suppressed ?? [];
  if (suppressed.length) {
    notes.push(
      `${suppressed.length} símbolo(s) tocado(s) no se compararon por un \`pr-validator-ignore duplication\` ` +
        `de la rama base: ${listSymbols(suppressed, true)}.`,
    );
  }

  const headIgnores = dup.headIgnores ?? [];
  if (headIgnores.length) {
    notes.push(
      `${headIgnores.length} \`pr-validator-ignore duplication\` los agrega este PR y no se aplicaron: ` +
        'un PR no puede declarar aceptable su propia copia; valen desde que estén en la rama base. ' +
        `Se compararon igual: ${listSymbols(headIgnores, true)}.`,
    );
  }

  const invalid = dup.invalidSuppressions ?? [];
  if (invalid.length) {
    notes.push(
      `${invalid.length} \`pr-validator-ignore duplication\` sin motivo no se aplicaron (el motivo es obligatorio): ` +
        `${listSymbols(invalid, false)}.`,
    );
  }

  return notes;
}
