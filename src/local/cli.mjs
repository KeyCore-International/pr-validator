// The local CLI: the validator's deterministic half, runnable on a developer's
// machine before a push.
//
// No subcommand calls a model. `prompts` writes what a model would be asked and
// `render` turns an answer into a verdict; who answers is the caller's business.
//
// Exit codes:
//   0  ok
//   1  usage error (bad flag, unreadable input file, malformed answer)
//   2  git error (not a repository, unknown ref)
//   4  tracked files have uncommitted changes
//   5  a ref that must be an ancestor of HEAD is not
//   6  HEAD moved during the run, or differs from --expect-head

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, LocalError, UsageError } from './errors.mjs';
import { GitError } from './git.mjs';
import { stableStringify } from './json.mjs';
import { writeFacts } from './facts.mjs';
import { writePrompts } from './prompts.mjs';
import { writeVerdict } from './render.mjs';
import { resolveRepoConfig } from './config.mjs';
import { buildInventory } from './inventory.mjs';
import { collectRules } from './rules.mjs';
import { ENGINE_VERSION } from './version.mjs';

const COMMON = `Common options:
  --repo <dir>          repository to read (default: current directory)
  --config <path>       config file inside the repository (default: .pr-validator.json)
  --help                show this help
  --version             print the engine version`;

const HELP = {
  main: `pr-local ${ENGINE_VERSION} — local mode of the pull request validator

Usage: pr-local <command> [options]

Commands:
  facts      branch facts: diff, classification, triggers, tier, history, duplication, coverage
  prompts    the system and user prompt each check would send in CI
  render     turn a reviewer's answer into the verdict CI would write
  config     the resolved repository configuration, including the "local" block
  inventory  exported symbols and signatures under the given directories
  rules      the rule corpus scoped to the touched files, plus extra rule packs

Run "pr-local <command> --help" for the options of one command.

Exit codes: 0 ok, 1 usage, 2 git error, 4 dirty tracked tree,
            5 base is not an ancestor, 6 HEAD moved.

${COMMON}`,

  facts: `Usage: pr-local facts --out <dir> [options]

Writes <out>/facts.json (sorted keys, deterministic), <out>/facts.md and
<out>/diff.patch for merge-base(base, HEAD)..HEAD. Refuses a dirty tracked tree.

Options:
  --out <dir>           output directory (required)
  --base <ref>          base ref (default: origin/develop)
  --since <ref>         also describe <ref>..HEAD (diff-since.patch); the tier
                        is still computed from the merge-base
  --triggers <file>     JSON trigger list; repeatable, patterns are added
  --attribution <file>  JSON array of extra commit-attribution patterns
  --fix                 raise the FIX trigger (an incident fix)
  --branch <name>       branch under review (default: the checked-out branch; a
                        detached checkout has none). FIX also fires for a
                        fix/ or hotfix/ branch; a fix(...) commit subject does not
  --quick | --full      force tier S (refused with AUTH/MIG/WRITE/SEED) or L
  --s-max <n>           S tier ceiling in production lines (default 400)
  --m-max <n>           M tier ceiling in production lines (default 1500)
  --expect-head <sha>   fail with 6 unless HEAD is this commit
  --allow-behind        record, instead of refusing, a base HEAD does not contain

${COMMON}`,

  prompts: `Usage: pr-local prompts --out <dir> [options]

Writes <out>/prompts/<check>.system.md, .user.md and .ctx.json for each check
that would call a model, or <check>.skip.json with the verdict reached without
one, plus <out>/prompts/index.json.

Options:
  --out <dir>           output directory (required)
  --base <ref>          base ref (default: origin/develop)
  --checks <a,b>        checks to prepare (default: all)
  --head-ref <name>     branch name as CI would see it (default: current branch)
  --title <text>        pull request title
  --body-file <file>    pull request body
  --task-file <file>    task JSON: one task with "id", or {"tasks": {"<id>": {...}}}
  --model <id>          model label recorded in the configuration

${COMMON}`,

  render: `Usage: pr-local render --out <dir> --check <name> [--in <answer.json>]

Reads <out>/prompts/<check>.ctx.json and the answer, and writes
<out>/verdicts/<check>.json in the shape CI writes. A check that "prompts"
resolved without a model needs no --in: its saved verdict is copied.

Options:
  --out <dir>           output directory used by "prompts" (required)
  --check <name>        check to render (required)
  --in <file>           the reviewer's JSON answer
  --model <id>          model label recorded in the verdict

${COMMON}`,

  config: `Usage: pr-local config [--base <ref>] [--out <dir>]

Prints the repository configuration as the working tree has it, the "local"
block, every check's resolved settings, and — with --base — the copy committed
on the base ref.

Options:
  --base <ref>          also read the configuration committed on this ref
  --out <dir>           also write <out>/config.json

${COMMON}`,

  inventory: `Usage: pr-local inventory --dirs <dir>[,<dir>…] [--out <dir>]

Prints the exported symbols, with signatures, under the given directories.

Options:
  --dirs <list>         repository-relative directories, globs allowed (required)
  --out <dir>           also write <out>/inventory.json

${COMMON}`,

  rules: `Usage: pr-local rules [--extra-dir <dir>]… [--touched <a,b> | --base <ref>] [--out <dir>]

Prints the rule corpus metadata. With --out, writes <out>/rules.json and the
corpus text to <out>/rules.md.

Options:
  --extra-dir <dir>     another rules directory, loaded and reported apart; repeatable
  --touched <list>      comma-separated touched paths to scope rules by
  --base <ref>          derive the touched paths from <ref>...HEAD
  --max-chars <n>       corpus budget (default: the rules check budget)
  --out <dir>           also write rules.json and rules.md

${COMMON}`,
};

/** Flags per command: name → 'value' | 'list' | 'bool'. */
const COMMON_FLAGS = { repo: 'value', config: 'value', help: 'bool', version: 'bool' };
const FLAGS = {
  facts: {
    out: 'value',
    base: 'value',
    since: 'value',
    triggers: 'list',
    attribution: 'value',
    fix: 'bool',
    branch: 'value',
    quick: 'bool',
    full: 'bool',
    's-max': 'value',
    'm-max': 'value',
    'expect-head': 'value',
    'allow-behind': 'bool',
  },
  prompts: {
    out: 'value',
    base: 'value',
    checks: 'value',
    'head-ref': 'value',
    title: 'value',
    'body-file': 'value',
    'task-file': 'value',
    model: 'value',
  },
  render: { out: 'value', check: 'value', in: 'value', model: 'value' },
  config: { base: 'value', out: 'value' },
  inventory: { dirs: 'value', out: 'value' },
  rules: { 'extra-dir': 'list', touched: 'value', base: 'value', 'max-chars': 'value', out: 'value' },
};

/**
 * Parse `--name value`, `--name=value` and boolean `--name`.
 *
 * @returns {Record<string, string|string[]|boolean>}
 */
export function parseArgs(args, spec) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument "${arg}"`);

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown option --${name}`);

    if (kind === 'bool') {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      out[name] = true;
      continue;
    }

    let value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      i += 1;
    }

    if (kind === 'list') (out[name] ??= []).push(value);
    else out[name] = value;
  }
  return out;
}

function required(opts, name) {
  if (!opts[name]) throw new UsageError(`--${name} is required`);
  return opts[name];
}

function positiveInt(opts, name) {
  if (opts[name] === undefined) return undefined;
  const n = Number(opts[name]);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer`);
  return n;
}

function list(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Print JSON to stdout and, when `--out` is given, write it as `<out>/<file>`. */
function emitJson(io, opts, file, value) {
  const text = stableStringify(value);
  if (opts.out) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, file), text, 'utf8');
  }
  io.stdout(text);
}

const COMMANDS = {
  async facts(opts, io) {
    if (opts.quick && opts.full) throw new UsageError('--quick and --full are exclusive');
    const facts = writeFacts({
      repo: opts.repo ?? '.',
      out: required(opts, 'out'),
      base: opts.base ?? 'origin/develop',
      since: opts.since ?? null,
      triggerFiles: opts.triggers ?? [],
      attributionFile: opts.attribution ?? null,
      fix: Boolean(opts.fix),
      branch: opts.branch ?? null,
      force: opts.quick ? 'quick' : opts.full ? 'full' : null,
      thresholds: Object.fromEntries(
        [
          ['sMax', positiveInt(opts, 's-max')],
          ['mMax', positiveInt(opts, 'm-max')],
        ].filter(([, value]) => value !== undefined),
      ),
      expectHead: opts['expect-head'] ?? null,
      allowBehind: Boolean(opts['allow-behind']),
      configPath: opts.config,
    });
    io.stdout(
      `facts: tier ${facts.tier.value}, ${facts.prodLines} production lines, ` +
        `triggers ${facts.triggers.ids.join(',') || 'none'} -> ${join(opts.out, 'facts.json')}\n`,
    );
  },

  async prompts(opts, io) {
    const index = await writePrompts({
      repo: opts.repo ?? '.',
      out: required(opts, 'out'),
      base: opts.base ?? 'origin/develop',
      checks: opts.checks,
      headRef: opts['head-ref'],
      title: opts.title ?? '',
      bodyFile: opts['body-file'] ?? null,
      taskFile: opts['task-file'] ?? null,
      configPath: opts.config,
      model: opts.model ?? '',
      log: io.stderr,
    });
    for (const entry of index.checks) {
      io.stdout(`${entry.check}: ${entry.kind === 'skip' ? `skip (${entry.status})` : 'prompt'}\n`);
    }
  },

  async render(opts, io) {
    const verdict = writeVerdict({
      out: required(opts, 'out'),
      check: required(opts, 'check'),
      inFile: opts.in ?? null,
      model: opts.model ?? '',
    });
    io.stdout(`${verdict.check}: ${verdict.status}${verdict.blocking ? '' : ' (non-blocking)'}\n`);
  },

  async config(opts, io) {
    const value = resolveRepoConfig({
      repo: opts.repo ?? '.',
      configPath: opts.config,
      base: opts.base ?? null,
    });
    emitJson(io, opts, 'config.json', value);
  },

  async inventory(opts, io) {
    const value = buildInventory({ repo: opts.repo ?? '.', dirs: list(required(opts, 'dirs')) });
    emitJson(io, opts, 'inventory.json', value);
  },

  async rules(opts, io) {
    if (opts.touched !== undefined && opts.base) {
      throw new UsageError('--touched and --base are exclusive');
    }
    const value = collectRules({
      repo: opts.repo ?? '.',
      extraDirs: opts['extra-dir'] ?? [],
      touched: opts.touched !== undefined ? list(opts.touched) : null,
      base: opts.base ?? null,
      maxChars: positiveInt(opts, 'max-chars') ?? null,
      configPath: opts.config,
    });
    const { text, ...meta } = value;
    if (opts.out) {
      mkdirSync(opts.out, { recursive: true });
      writeFileSync(join(opts.out, 'rules.md'), text, 'utf8');
    }
    emitJson(io, opts, 'rules.json', meta);
  },
};

/**
 * Run the CLI.
 *
 * @param {string[]} argv  Arguments after the script name.
 * @param {{stdout?: (s: string) => void, stderr?: (s: string) => void}} [io]
 * @returns {Promise<number>} the exit code.
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const out = {
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(`${text}\n`)),
  };

  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    out.stdout(`${HELP.main}\n`);
    return EXIT.OK;
  }
  if (command === '--version' || command === '-v') {
    out.stdout(`${ENGINE_VERSION}\n`);
    return EXIT.OK;
  }

  try {
    if (!COMMANDS[command]) throw new UsageError(`unknown command "${command}"`);
    const opts = parseArgs(rest, { ...COMMON_FLAGS, ...FLAGS[command] });
    if (opts.help) {
      out.stdout(`${HELP[command]}\n`);
      return EXIT.OK;
    }
    if (opts.version) {
      out.stdout(`${ENGINE_VERSION}\n`);
      return EXIT.OK;
    }
    await COMMANDS[command](opts, out);
    return EXIT.OK;
  } catch (err) {
    if (err instanceof LocalError) {
      out.stderr(`pr-local: ${err.message}`);
      if (err.exitCode === EXIT.USAGE && !COMMANDS[command]) out.stderr('Run "pr-local --help".');
      return err.exitCode;
    }
    if (err instanceof GitError) {
      out.stderr(`pr-local: ${err.message}`);
      return EXIT.GIT;
    }
    // Not a refusal this tool knows how to name. Reported with its stack, under
    // the usage code: the caller cannot proceed either way.
    out.stderr(`pr-local: unexpected error: ${err?.stack ?? err}`);
    return EXIT.USAGE;
  }
}

