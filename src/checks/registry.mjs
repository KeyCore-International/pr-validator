// Check registry.
//
// A check is a self-contained folder exporting a fixed shape, so adding one
// means adding a folder and a line here — the runner never changes (BR-13):
//
//   src/checks/<name>/prompt.md     the prompt, editable as prose
//   src/checks/<name>/config.json   model, blocking, budgets, failOn
//   src/checks/<name>/render.mjs    contextNeeds + buildPrompt + render
//
// Imports are static rather than a directory scan: the checks ship inside a
// bundled action, where there is no `src/checks/` to read at runtime.

import * as criteria from './criteria/render.mjs';
import * as security from './security/render.mjs';
import * as rules from './rules/render.mjs';

/** Display order in the consolidated comment. Stable regardless of job timing. */
export const CHECK_ORDER = ['criteria', 'security', 'rules', 'quality', 'duplication', 'tests'];

const REGISTRY = { criteria, security, rules };

export class UnknownCheckError extends Error {
  constructor(name) {
    super(`Unknown check "${name}". Available: ${listChecks().join(', ')}`);
    this.name = 'UnknownCheckError';
  }
}

/** Names of every implemented check, in display order. */
export function listChecks() {
  return CHECK_ORDER.filter((name) => name in REGISTRY);
}

/**
 * @param {string} name
 * @returns {{
 *   meta: {name: string, title: string, contextNeeds: string[]},
 *   config: object,
 *   buildPrompt: (ctx: object) => {system: string, prompt: string},
 *   render: (parsed: object, ctx: object) => object|null
 * }}
 * @throws {UnknownCheckError}
 */
export function getCheck(name) {
  const mod = REGISTRY[name];
  if (!mod) throw new UnknownCheckError(name);
  assertShape(name, mod);
  return mod;
}

/** Sort check names into display order, keeping unknown names at the end. */
export function sortChecks(names) {
  return [...names].sort((a, b) => {
    const ia = CHECK_ORDER.indexOf(a);
    const ib = CHECK_ORDER.indexOf(b);
    return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
  });
}

// Fails at load time rather than mid-run: a malformed check should break CI on
// the validator, not a consumer's pull request.
function assertShape(name, mod) {
  const missing = [];
  if (!mod.meta?.title) missing.push('meta.title');
  if (!Array.isArray(mod.meta?.contextNeeds)) missing.push('meta.contextNeeds');
  if (typeof mod.buildPrompt !== 'function') missing.push('buildPrompt');
  if (typeof mod.render !== 'function') missing.push('render');
  if (missing.length) {
    throw new Error(`Check "${name}" is missing: ${missing.join(', ')}`);
  }
}
