// The local bundle: built from src/ by the same script CI verifies, free of the
// model client, runnable as a CLI and importable as a module.
//
// The bundle is built into a temporary directory rather than read from
// dist/local, so this proves what src/ produces today and never depends on the
// committed artifact being fresh — `build:check` is the gate for that.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { bundle, forbidPlugin, TARGETS } from '../scripts/build.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LOCAL = TARGETS.find((target) => target.name === 'local');

let dir;
let file;
let code;

beforeAll(async () => {
  code = await bundle(LOCAL.entry, { forbid: LOCAL.forbid });
  dir = mkdtempSync(join(tmpdir(), 'prl-bundle-'));
  // Same file name as the real output, so `invokedDirectly` sees what it sees there.
  mkdirSync(join(dir, 'dist', 'local'), { recursive: true });
  file = join(dir, 'dist', 'local', 'pr-local.mjs');
  writeFileSync(file, code, 'utf8');
}, 60_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('local bundle', () => {
  it('is a forbid target written to dist/local/pr-local.mjs', () => {
    expect(LOCAL).toMatchObject({ out: 'dist/local/pr-local.mjs', forbid: true });
  });

  it('does not contain the model client or the task-manager client', () => {
    expect(code).not.toContain('from "ai"');
    expect(code).not.toContain("from 'ai'");
    expect(code).not.toContain('import("ai")');
    expect(code).not.toContain('generateText');
    expect(code).not.toContain('TASKS_API');
  });

  it('runs as a CLI: --help and --version exit 0', () => {
    const help = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Usage: pr-local <command>');

    const version = spawnSync(process.execPath, [file, '--version'], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('maps a usage error to exit 1', () => {
    const result = spawnSync(process.execPath, [file, 'facts', '--nope'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown option --nope');
  });

  it('is importable as a module without starting the CLI', () => {
    const script =
      `const m = await import(${JSON.stringify(pathToFileURL(file).href)});` +
      "console.log(['nameSimilarity','signatureSimilarity','bodySimilarity','buildSymbolIndex'," +
      "'matchesAny','declaredScope','isLogicBearing','computeTier','main'].every((k) => typeof m[k] === 'function'));";
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(out.trim()).toBe('true');
  });

  it('fails the build when a forbid target reaches the gateway or the SDK', async () => {
    const gateway = join(ROOT, 'src', 'gateway.mjs').replace(/\\/g, '/');
    const cases = [
      ['via-gateway.mjs', `export * from ${JSON.stringify(gateway)};\n`],
      ['via-sdk.mjs', "export { generateText } from 'ai';\n"],
      ['via-scoped.mjs', "export * from '@ai-sdk/openai';\n"],
    ];

    for (const [name, source] of cases) {
      const entry = join(dir, name);
      writeFileSync(entry, source, 'utf8');
      await expect(
        build({
          entryPoints: [entry],
          bundle: true,
          platform: 'node',
          format: 'esm',
          write: false,
          logLevel: 'silent',
          plugins: [forbidPlugin],
        }),
      ).rejects.toThrow(/may not be bundled/);
    }
  });
});
