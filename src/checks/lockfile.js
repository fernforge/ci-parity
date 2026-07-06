'use strict';

const fs = require('fs');
const path = require('path');
const { steps } = require('../workflows');

function read(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

// Does any workflow run a frozen install (`npm ci`, `--frozen-lockfile`, `--immutable`)?
function usesFrozenInstall(workflows) {
  for (const wf of workflows) {
    if (!wf.doc) continue;
    for (const { step } of steps(wf.doc)) {
      const run = typeof step.run === 'string' ? step.run : '';
      if (/\bnpm\s+ci\b/.test(run)) return 'npm ci';
      if (/--frozen-lockfile\b/.test(run)) return 'pnpm/yarn --frozen-lockfile';
      if (/--immutable\b/.test(run)) return 'yarn --immutable';
      if (/\byarn\s+install\b/.test(run) && !/--no-immutable/.test(run)) {
        // yarn v2+ is immutable in CI by default
      }
    }
  }
  return null;
}

// Collect the package names present in a package-lock.json (v2/v3 "packages" map).
function lockPackageNames(lock) {
  const names = new Set();
  if (lock && lock.packages && typeof lock.packages === 'object') {
    for (const key of Object.keys(lock.packages)) {
      if (key === '') continue;
      const m = key.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
      if (m) names.add(m[1]);
    }
  }
  // v1 fallback
  if (lock && lock.dependencies && typeof lock.dependencies === 'object') {
    for (const n of Object.keys(lock.dependencies)) names.add(n);
  }
  return names;
}

function checkLockfileStaleness(root, workflows, findings) {
  const pkgRaw = read(root, 'package.json');
  if (!pkgRaw) return;
  let pkg;
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    findings.push({
      level: 'error',
      class: 'package-json-invalid',
      title: 'package.json is not valid JSON',
      detail: 'CI will fail at the install step before running anything.',
      evidence: ['package.json failed to parse'],
      fix: 'Fix the JSON syntax in package.json.',
    });
    return;
  }

  const frozen = usesFrozenInstall(workflows);
  const lockRaw = read(root, 'package-lock.json');

  // Only npm's package-lock is machine-checkable here; skip when the repo uses another manager.
  const hasPnpm = fs.existsSync(path.join(root, 'pnpm-lock.yaml'));
  const hasYarn = fs.existsSync(path.join(root, 'yarn.lock'));

  if (!lockRaw) {
    if (frozen === 'npm ci' && !hasPnpm && !hasYarn) {
      findings.push({
        level: 'error',
        class: 'lockfile-missing',
        title: 'A workflow runs `npm ci` but package-lock.json is not committed',
        detail: '`npm ci` requires a lockfile and exits non-zero without one. This fails in CI every time.',
        evidence: ['workflow step: npm ci', 'missing: package-lock.json'],
        fix: 'Run `npm install` and commit the generated package-lock.json.',
      });
    }
    return;
  }

  let lock;
  try {
    lock = JSON.parse(lockRaw);
  } catch {
    return;
  }

  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
  const inLock = lockPackageNames(lock);
  const missing = Object.keys(declared).filter((name) => !inLock.has(name));

  if (missing.length > 0) {
    findings.push({
      level: frozen ? 'error' : 'warn',
      class: 'lockfile-stale',
      title: `${missing.length} dependenc${missing.length === 1 ? 'y is' : 'ies are'} in package.json but not in package-lock.json`,
      detail: frozen
        ? `A workflow runs a frozen install (${frozen}), which refuses to reconcile the lockfile and exits non-zero. Passes locally with \`npm install\`, fails in CI.`
        : 'The lockfile is out of sync with package.json. A frozen CI install (`npm ci`) would reject it.',
      evidence: [
        `out of sync: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` (+${missing.length - 8} more)` : ''}`,
        frozen ? `workflow install: ${frozen}` : 'no frozen install detected (still risky)',
      ],
      fix: 'Run `npm install` to regenerate package-lock.json, then commit it.',
    });
  }
}

module.exports = { checkLockfileStaleness };
