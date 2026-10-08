// What each changed file is: production code, or one of the kinds of file that
// is not production code.
//
// Two consumers read this one table. The local mode counts production lines
// with it to pick a review tier, and the diff context keeps the files that are
// not written by hand (lockfiles, snapshots, generated output) out of the
// prompt budget. Two copies of the table would drift, and a file the tier calls
// generated while the diff budget spends on it is exactly that drift.

import { isCodeFile } from './files.mjs';

/**
 * Categories, checked in order; the first match wins. `prod` is what is left.
 * Patterns run against the forward-slash path git prints.
 */
const CATEGORIES = [
  ['lockfile', /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|packages\.lock\.json|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock)$/i],
  ['tooling', /(^|\/)\.(claude|agents)\//i],
  ['docs', /\.(md|mdx|markdown|rst|adoc|txt)$/i],
  ['snapshot', /(^|\/)__snapshots__\/|\.snap$/i],
  [
    'test',
    /(\.|_)(test|spec)\.[a-z]+$|Tests?\.(cs|php|java|kt)$|(^|\/)(tests?|__tests__|__mocks__|spec|e2e|cypress|playwright)\/|(^|\/)[^/]*\.(Tests?|UnitTests|IntegrationTests)(\.[^/]+)?\//i,
  ],
  [
    'generated',
    /\.Designer\.cs$|ModelSnapshot\.cs$|\.g\.(cs|ts|dart)$|\.generated\.[a-z]+$|\.min\.(js|css)$|(^|\/)(dist|\.nuxt|\.output|\.next|obj)\//i,
  ],
  ['locale', /(^|\/)(locales?|i18n|lang|translations)\/.*\.(json|ya?ml)$/i],
  ['style', /\.(css|scss|sass|less|styl)$/i],
];

/**
 * Categories nobody reviews line by line: written by a tool, not by the author.
 * The diff context leaves them out of the prompt budget before truncating, so a
 * 40 000-character `.Designer.cs` cannot push hand-written files out of view.
 */
export const BUDGET_EXEMPT_CATEGORIES = new Set(['lockfile', 'snapshot', 'generated']);

/**
 * The category of one path.
 *
 * @param {string} path
 * @returns {'lockfile'|'tooling'|'docs'|'snapshot'|'test'|'generated'|'locale'|'style'|'asset'|'prod'}
 */
export function categorize(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  for (const [category, pattern] of CATEGORIES) {
    if (pattern.test(normalized)) return category;
  }
  // Images, fonts, archives and the like: not prose, not code.
  if (!isCodeFile(normalized)) return 'asset';
  return 'prod';
}

/** Is this path left out of the diff budget? */
export function isBudgetExempt(path) {
  return BUDGET_EXEMPT_CATEGORIES.has(categorize(path));
}
