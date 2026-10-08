// The local bundle's module surface.
//
// The same file is a CLI and an ES module: helper scripts import the engine's
// deterministic signals from it instead of re-implementing them, so a
// similarity score or a rule scope means the same thing in every tool that
// reports one.

export { nameSimilarity } from '../similarity/name.mjs';
export { signatureSimilarity } from '../similarity/signature.mjs';
export { bodySimilarity } from '../similarity/body.mjs';
export { buildSymbolIndex } from '../context/symbol-index.mjs';
export { declaredScope, matchesAny } from '../context/rules.mjs';
// Size, nesting, cyclomatic complexity and the logic-bearing predicate.
export * from '../similarity/metrics.mjs';

export { categorize, classifyRange } from './classify.mjs';
export { computeTier, DEFAULT_THRESHOLDS, HARD_TRIGGERS } from './tier.mjs';
export { BUILTIN_TRIGGERS, compilePattern, evaluateTriggers, mergeTriggerSpecs } from './triggers.mjs';
export { compact, sortKeys, stableStringify } from './json.mjs';
export { EXIT } from './errors.mjs';
export { ENGINE_VERSION } from './version.mjs';
export { main } from './cli.mjs';
