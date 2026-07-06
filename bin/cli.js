#!/usr/bin/env node
'use strict';

const path = require('path');
const { analyze } = require('../src/index');

const args = process.argv.slice(2);

function has(flag) {
  return args.includes(flag);
}

if (has('-h') || has('--help')) {
  printHelp();
  process.exit(0);
}

if (has('-v') || has('--version')) {
  const pkg = require('../package.json');
  process.stdout.write(pkg.version + '\n');
  process.exit(0);
}

const C = process.stdout.isTTY
  ? { red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m` }
  : { red: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s, green: (s) => s };

const positional = args.filter((a) => !a.startsWith('-'));
const root = path.resolve(positional[0] || process.cwd());
const jsonOut = has('--json');
const warnOnly = has('--warn-only'); // never exit non-zero on warnings/errors (report only)
const strict = has('--strict'); // exit non-zero on warnings too, not just errors

let result;
try {
  result = analyze(root);
} catch (err) {
  process.stderr.write('ci-parity: ' + err.message + '\n');
  process.exit(2);
}

if (jsonOut) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  printHuman(result, root);
}

const errors = result.findings.filter((f) => f.level === 'error').length;
const warns = result.findings.filter((f) => f.level === 'warn').length;

if (warnOnly) process.exit(0);
if (errors > 0) process.exit(1);
if (strict && warns > 0) process.exit(1);
process.exit(0);

// ---- output helpers ----

function badge(level) {
  if (level === 'error') return C.red('fail-in-ci');
  if (level === 'warn') return C.yellow('parity-risk');
  return C.dim('note');
}

function printHuman(result, root) {
  const rel = path.relative(process.cwd(), root) || '.';
  if (result.workflowCount === 0) {
    process.stdout.write(`ci-parity: no .github/workflows/*.yml found under ${rel}\n`);
    return;
  }

  const order = { error: 0, warn: 1, info: 2 };
  const findings = [...result.findings].sort((a, b) => order[a.level] - order[b.level]);

  process.stdout.write(`\nci-parity  scanned ${result.workflowCount} workflow file(s) in ${rel}\n\n`);

  if (findings.length === 0) {
    process.stdout.write(C.green('  No local-vs-CI parity problems detected.\n\n'));
    return;
  }

  for (const f of findings) {
    process.stdout.write(`  [${badge(f.level)}] ${C.bold(f.title)}\n`);
    if (f.detail) process.stdout.write(`    ${f.detail}\n`);
    for (const e of f.evidence || []) process.stdout.write(C.dim(`    - ${e}\n`));
    if (f.fix) process.stdout.write(`    ${C.green('fix:')} ${f.fix}\n`);
    process.stdout.write('\n');
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  process.stdout.write(
    `  ${errors} likely-to-fail-in-CI, ${warns} parity risk(s).` +
      (errors ? ' Push will likely fail CI.\n\n' : '\n\n')
  );
}

function printHelp() {
  process.stdout.write(
    `ci-parity — predict "passes locally, fails in CI" before you push

Usage:
  ci-parity [path]           Scan a repo (default: current directory)
  npx ci-parity

Options:
  --json         Machine-readable output
  --strict       Exit 1 on parity risks (warnings) too, not just likely failures
  --warn-only    Always exit 0 (report without blocking)
  -h, --help     Show this help
  -v, --version  Show version

Exit codes:
  0  no likely-CI failures (default) / report-only mode
  1  at least one finding that will likely fail CI (or any finding with --strict)
  2  internal error

What it checks (statically, no Docker, no network):
  - Node/tool version drift across .nvmrc, .tool-versions, package.json engines,
    setup-node in your workflow, and your locally-installed node
  - packageManager (Corepack) field vs the committed lockfile
  - Lockfile staleness that breaks \`npm ci\` / frozen installs
  - Env/secrets a workflow injects that your shell and .env lack
  - Shell steps that behave differently on macOS/Windows than the Linux runner

Pre-push hook (simple-git-hooks):
  "simple-git-hooks": { "pre-push": "npx ci-parity" }
`
  );
}
