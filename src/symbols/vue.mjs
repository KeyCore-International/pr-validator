// Symbols in a Vue single-file component.
//
// Two things worth naming live in a `.vue` file:
//
//   1. The component itself. Its name comes from the filename, because that is
//      how everyone imports it and how the test file is almost always named.
//   2. Anything the script block exports — composables and helpers that leaked
//      into a component file and are used elsewhere.
//
// The second is delegated to the TypeScript extractor: a `<script setup>` block
// is TypeScript, and duplicating those patterns here would mean fixing every
// future bug twice.

import { extract as extractScript } from './typescript.mjs';

/** `components/vacancy/VacancyCard.vue` -> `VacancyCard` */
export function componentNameFromPath(path) {
  const file = String(path || '').split('/').pop() ?? '';
  const base = file.replace(/\.vue$/i, '');
  if (!base) return '';

  // `vacancy-card.vue` and `vacancy_card.vue` are both written as VacancyCard
  // in an import, so that is the name a test would reference.
  return base
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * @param {Array<{line: number, text: string}>} lines
 * @param {string} path
 * @returns {Array<{name: string, kind: string, line: number, signature: string, exported: boolean}>}
 */
export function extract(lines, path = '') {
  const name = componentNameFromPath(path);
  const out = [];

  // A component counts as touched when the diff adds anything to its file —
  // template, script or style. Reporting per-line would produce one symbol per
  // added line, which says nothing useful.
  if (name && lines.length) {
    out.push({
      name,
      kind: 'component',
      line: lines[0].line,
      signature: `<${name} />`,
      exported: true,
    });
  }

  out.push(...extractScript(lines));
  return out;
}
