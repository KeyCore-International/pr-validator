// Symbols in a Vue single-file component.
//
// Three things worth naming live in a `.vue` file:
//
//   1. The component itself. Its name comes from the filename, because that is
//      how everyone imports it and how the test file is almost always named. It
//      carries a `templateSkeleton` — the tag structure of its template — so two
//      components can be compared by what they render.
//   2. Anything the script block exports — composables and helpers that leaked
//      into a component file and are used elsewhere.
//   3. The functions a `<script setup>` block declares. They are private to the
//      component (`scope: 'private'`), and they are where a formatter gets
//      copied from one component into the next.
//
// The script is delegated to the TypeScript extractor: a `<script setup>` block
// is TypeScript, and duplicating those patterns here would mean fixing every
// future bug twice. Only the script block's own lines are handed over, with the
// line numbers they have in the file, so every symbol points at its real line.

import { extract as extractScript } from './typescript.mjs';
import { MAX_NAME_CHARS } from './limits.mjs';

/** Tokens kept in a template skeleton. Enough to compare, bounded for a page-long template. */
const MAX_SKELETON_TOKENS = 400;

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
 * The script blocks of a component, each with its own lines.
 *
 * Returns null when no `<script>` tag is among the lines — which is what reading
 * only the added lines of a diff looks like when the tag itself was not
 * touched. The caller then reads every line as script, as it always did.
 *
 * @param {Array<{line: number, text: string}>} lines
 * @returns {Array<{setup: boolean, lines: Array<{line: number, text: string}>}>|null}
 */
export function scriptBlocks(lines) {
  const blocks = [];
  let current = null;

  for (const entry of lines) {
    // CRLF: `.` does not match the `\r`, so `(.*)$` below would never match.
    const text = String(entry.text ?? '').replace(/\r$/, '');

    if (!current) {
      const open = text.match(/^\s*<script\b([^>]*)>(.*)$/i);
      if (!open) continue;
      current = { setup: /\bsetup\b/.test(open[1]), lines: [] };
      // `<script setup>const a = 1</script>` on one line.
      const rest = open[2];
      const close = rest.search(/<\/script\s*>/i);
      if (close !== -1) {
        if (rest.slice(0, close).trim()) current.lines.push({ line: entry.line, text: rest.slice(0, close) });
        blocks.push(current);
        current = null;
      } else if (rest.trim()) {
        current.lines.push({ line: entry.line, text: rest });
      }
      continue;
    }

    const close = text.search(/<\/script\s*>/i);
    if (close !== -1) {
      if (text.slice(0, close).trim()) current.lines.push({ line: entry.line, text: text.slice(0, close) });
      blocks.push(current);
      current = null;
      continue;
    }

    current.lines.push(entry);
  }

  // An unclosed block still holds script.
  if (current) blocks.push(current);
  return blocks.length ? blocks : null;
}

/**
 * The tag structure of the template, as one string: `div h2 /h2 AppButton/ /div`.
 *
 * Attributes, text and interpolations are left out — two components that
 * render the same structure with different labels have the same skeleton,
 * which is the point. The outer `<template>` is left out too.
 *
 * @param {Array<{line: number, text: string}>} lines
 * @returns {string|null} null when the lines hold no template
 */
export function templateSkeleton(lines) {
  const texts = lines.map((entry) => String(entry.text ?? '').replace(/\r$/, ''));
  const start = texts.findIndex((text) => /^\s*<template\b/i.test(text));
  if (start === -1) return null;

  let end = -1;
  for (let i = texts.length - 1; i > start; i -= 1) {
    if (/<\/template\s*>/i.test(texts[i])) {
      end = i;
      break;
    }
  }

  const body = texts
    .slice(start, end === -1 ? texts.length : end + 1)
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const tokens = [];
  // Attribute values are skipped as quoted runs, so a `>` inside `v-if="a > b"`
  // does not end the tag early.
  const tag = /<(\/?)([A-Za-z][\w.:-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g;

  for (const match of body.matchAll(tag)) {
    tokens.push(`${match[1]}${match[2]}${match[4]}`);
    if (tokens.length > MAX_SKELETON_TOKENS + 2) break;
  }

  // Drop the outer `<template>` … `</template>` pair.
  if (tokens[0] === 'template') tokens.shift();
  if (tokens[tokens.length - 1] === '/template') tokens.pop();

  return tokens.slice(0, MAX_SKELETON_TOKENS).join(' ');
}

/**
 * @param {Array<{line: number, text: string}>} lines
 * @param {string} path
 * @returns {Array<{name: string, kind: string, line: number, signature: string, exported: boolean,
 *   scope: string, container: string|null, span: [number, number], templateSkeleton?: string}>}
 */
export function extract(lines, path = '') {
  // The path is read from a diff header, so its length is the pull request's to
  // choose. Capping the name here bounds the signature built from it as well.
  const name = componentNameFromPath(path).slice(0, MAX_NAME_CHARS);
  const out = [];

  // A component counts as touched when the diff adds anything to its file —
  // template, script or style. Reporting per-line would produce one symbol per
  // added line, which says nothing useful.
  if (name && lines.length) {
    const component = {
      name,
      kind: 'component',
      line: lines[0].line,
      signature: `<${name} />`,
      exported: true,
      scope: 'exported',
      container: null,
      span: [lines[0].line, lines[lines.length - 1].line],
    };
    const skeleton = templateSkeleton(lines);
    if (skeleton !== null) component.templateSkeleton = skeleton;
    out.push(component);
  }

  const blocks = scriptBlocks(lines);
  if (!blocks) {
    out.push(...extractScript(lines));
    return out;
  }

  for (const block of blocks) {
    for (const symbol of extractScript(block.lines)) {
      out.push(block.setup ? asSetupSymbol(symbol, name) : asOptionsSymbol(symbol, name));
    }
  }

  return out;
}

/**
 * A top-level declaration of `<script setup>` belongs to the component: nothing
 * outside it can call the function, so it is private, and its container is the
 * component.
 */
function asSetupSymbol(symbol, component) {
  if (symbol.scope === 'module') {
    return { ...symbol, scope: 'private', container: component || null };
  }
  if (symbol.container === null && symbol.scope === 'inner') {
    return { ...symbol, container: component || null };
  }
  return symbol;
}

/**
 * In the options API the component is `export default {…}`, which the script
 * extractor names `default`. Its members are the component's.
 */
function asOptionsSymbol(symbol, component) {
  if (!component || typeof symbol.container !== 'string') return symbol;
  if (symbol.container !== 'default' && !symbol.container.startsWith('default.')) return symbol;
  return { ...symbol, container: component + symbol.container.slice('default'.length) };
}
