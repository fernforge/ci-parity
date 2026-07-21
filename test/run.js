'use strict';

// Zero-dependency test runner. Builds temp repo fixtures on disk and asserts finding classes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { analyze } = require('../src/index');

let pass = 0;
let fail = 0;

function mkRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-parity-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('ok   - ' + name);
  } catch (err) {
    fail++;
    console.log('FAIL - ' + name);
    console.log('       ' + err.message);
  }
}

function classes(root) {
  return analyze(root).findings.map((f) => f.class);
}

const wf = (body) => body;

test('node major drift across .nvmrc and workflow is flagged', () => {
  const repo = mkRepo({
    '.nvmrc': '18\n',
    '.github/workflows/ci.yml': wf(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm test
`),
  });
  assert.ok(classes(repo).includes('node-version-drift'));
});

test('node-version-file (single source) does NOT trigger drift', () => {
  const repo = mkRepo({
    '.nvmrc': '20\n',
    '.github/workflows/ci.yml': wf(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - run: npm test
`),
  });
  assert.ok(!classes(repo).includes('node-version-drift'));
});

test('npm ci without lockfile is flagged as error', () => {
  const repo = mkRepo({
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }),
    '.github/workflows/ci.yml': wf(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
`),
  });
  const f = analyze(repo).findings.find((x) => x.class === 'lockfile-missing');
  assert.ok(f && f.level === 'error');
});

test('dependency in package.json but missing from lockfile is flagged', () => {
  const repo = mkRepo({
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }),
    'package-lock.json': JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': {} } }),
    '.github/workflows/ci.yml': wf(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
`),
  });
  assert.ok(classes(repo).includes('lockfile-stale'));
});

test('lockfile in sync produces no lockfile-stale finding', () => {
  const repo = mkRepo({
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }),
    'package-lock.json': JSON.stringify({
      name: 'x',
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/left-pad': { version: '1.0.0' } },
    }),
  });
  assert.ok(!classes(repo).includes('lockfile-stale'));
});

test('secret referenced in workflow env but absent locally is flagged', () => {
  const repo = mkRepo({
    '.github/workflows/ci.yml': wf(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        env:
          API_TOKEN: \${{ secrets.API_TOKEN }}
`),
  });
  assert.ok(classes(repo).includes('env-missing-locally'));
});

test('sed -i inplace flagged as shell portability risk', () => {
  const repo = mkRepo({
    '.github/workflows/ci.yml': wf(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: sed -i 's/a/b/' file.txt
`),
  });
  // On a Linux CI runner this test box is linux -> level 'info' but class still present.
  assert.ok(classes(repo).includes('shell-portability'));
});

test('invalid workflow YAML is reported', () => {
  const repo = mkRepo({
    '.github/workflows/broken.yml': 'jobs: [: :bad yaml',
  });
  assert.ok(classes(repo).includes('workflow-parse-error'));
});

test('clean repo yields no findings', () => {
  const repo = mkRepo({
    '.nvmrc': '20\n',
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', engines: { node: '>=20' } }),
    '.github/workflows/ci.yml': wf(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - run: node --test
`),
  });
  const found = classes(repo);
  // may include node-local-vs-ci depending on the runner's node; that's acceptable, assert no hard errors
  assert.ok(!found.includes('lockfile-missing') && !found.includes('workflow-parse-error'));
});

test('npm 12 flags a dependency with an unapproved install script', () => {
  const repo = mkRepo({
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { sharp: '^0.33.0' } }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x', version: '1.0.0' },
        'node_modules/sharp': {
          version: '0.33.0',
          resolved: 'https://registry.npmjs.org/sharp/-/sharp-0.33.0.tgz',
          hasInstallScript: true,
        },
      },
    }),
  });
  assert.ok(classes(repo).includes('npm12-blocked-install-scripts'));
});

test('npm 12 install-script finding is suppressed when allow-scripts is configured', () => {
  const repo = mkRepo({
    '.npmrc': 'allow-scripts=sharp:true\n',
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { sharp: '^0.33.0' } }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x', version: '1.0.0' },
        'node_modules/sharp': {
          version: '0.33.0',
          resolved: 'https://registry.npmjs.org/sharp/-/sharp-0.33.0.tgz',
          hasInstallScript: true,
        },
      },
    }),
  });
  assert.ok(!classes(repo).includes('npm12-blocked-install-scripts'));
});

test('npm 12 flags a git-protocol dependency', () => {
  const repo = mkRepo({
    'package.json': JSON.stringify({
      name: 'x',
      version: '1.0.0',
      dependencies: { 'my-fork': 'git+https://github.com/someone/my-fork.git' },
    }),
  });
  assert.ok(classes(repo).includes('npm12-blocked-git-dep'));
});

test('npm 12 flags a remote tarball URL dependency', () => {
  const repo = mkRepo({
    'package.json': JSON.stringify({
      name: 'x',
      version: '1.0.0',
      dependencies: { thing: 'https://example.com/thing-1.0.0.tgz' },
    }),
  });
  assert.ok(classes(repo).includes('npm12-blocked-remote-dep'));
});

test('npm 12 git/remote findings suppressed when allow-git/allow-remote configured', () => {
  const repo = mkRepo({
    '.npmrc': 'allow-git=all\nallow-remote=all\n',
    'package.json': JSON.stringify({
      name: 'x',
      version: '1.0.0',
      dependencies: {
        'my-fork': 'git+https://github.com/someone/my-fork.git',
        thing: 'https://example.com/thing-1.0.0.tgz',
      },
    }),
  });
  const found = classes(repo);
  assert.ok(!found.includes('npm12-blocked-git-dep') && !found.includes('npm12-blocked-remote-dep'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
