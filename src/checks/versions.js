'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { steps } = require('../workflows');

function readFile(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

// Reduce a version spec to a comparable major (or major.minor) string.
function normMajor(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/^v/i, '').replace(/^[~^>=<\s]+/, '');
  const m = s.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return m[1];
}

function localNodeMajor() {
  try {
    const out = execFileSync(process.execPath, ['-v'], { encoding: 'utf8' });
    return normMajor(out);
  } catch {
    return normMajor(process.version);
  }
}

// Collect every declared Node version and where it came from.
function collectNodeSources(root, workflows) {
  const sources = [];

  const nvmrc = readFile(root, '.nvmrc');
  if (nvmrc && nvmrc.trim()) sources.push({ where: '.nvmrc', raw: nvmrc.trim(), major: normMajor(nvmrc) });

  const toolVersions = readFile(root, '.tool-versions');
  if (toolVersions) {
    const line = toolVersions.split('\n').find((l) => /^\s*nodejs\s/.test(l));
    if (line) {
      const raw = line.replace(/^\s*nodejs\s+/, '').trim();
      sources.push({ where: '.tool-versions', raw, major: normMajor(raw) });
    }
  }

  const pkgRaw = readFile(root, 'package.json');
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const eng = pkg.engines && pkg.engines.node;
      if (eng) {
        const s = String(eng).trim();
        // A `>=`/`>` engines spec is a floor, not a pin — a higher local/CI version satisfies it.
        // Only `^`/`~`/`x`-range/exact specs pin a specific major.
        const isFloor = /^\s*>=?\s*\d/.test(s) && !/[|]|<|\^|~/.test(s);
        sources.push({
          where: 'package.json engines.node',
          raw: eng,
          major: normMajor(eng),
          kind: isFloor ? 'floor' : 'pin',
        });
      }
    } catch {
      /* handled by lockfile check */
    }
  }

  for (const wf of workflows) {
    if (!wf.doc) continue;
    for (const { step } of steps(wf.doc)) {
      const uses = typeof step.uses === 'string' ? step.uses : '';
      if (/actions\/setup-node/.test(uses)) {
        const withBlock = step.with || {};
        if (withBlock['node-version-file']) {
          // Points at .nvmrc/.tool-versions etc. — single-source, healthy. Note it but don't flag.
          sources.push({
            where: `${wf.name} setup-node node-version-file`,
            raw: String(withBlock['node-version-file']),
            major: null,
            file: true,
          });
        } else if (withBlock['node-version']) {
          const raw = String(withBlock['node-version']);
          sources.push({ where: `${wf.name} setup-node node-version`, raw, major: normMajor(raw) });
        }
      }
    }
  }

  return sources;
}

function checkNodeDrift(root, workflows, findings) {
  const sources = collectNodeSources(root, workflows);
  // Exact pins participate in the equality check; floors (`>=16`) are constraints checked separately.
  const pinned = sources.filter((s) => s.major != null && s.kind !== 'floor');
  const floors = sources.filter((s) => s.kind === 'floor' && s.major != null);

  // A concrete pin below an engines floor is a real conflict.
  for (const floor of floors) {
    for (const p of pinned) {
      if (Number(p.major) < Number(floor.major)) {
        findings.push({
          level: 'error',
          class: 'node-version-drift',
          title: `${p.where} pins Node ${p.major}.x, below ${floor.where} (${floor.raw})`,
          detail: 'A version that violates your engines floor. Installs of engine-strict deps and CI will diverge from local.',
          evidence: [`${p.where}: Node ${p.major}.x`, `${floor.where}: ${floor.raw}`],
          fix: `Raise ${p.where} to satisfy ${floor.raw}, or lower the engines floor.`,
        });
      }
    }
  }

  if (pinned.length === 0) return;

  const majors = new Set(pinned.map((s) => s.major));

  if (majors.size > 1) {
    findings.push({
      level: 'error',
      class: 'node-version-drift',
      title: 'Node major version disagrees across your config files',
      detail:
        'Different files pin different Node majors. CI uses one, your machine may use another, and behavior diverges silently.',
      evidence: pinned.map((s) => `${s.where}: ${s.raw} (Node ${s.major}.x)`),
      fix: 'Pick one source of truth. Put the version in .nvmrc and point the workflow at it with actions/setup-node `node-version-file: .nvmrc`, then match package.json engines.node.',
    });
    return;
  }

  // All declared sources agree — now compare against the locally running Node.
  const declaredMajor = pinned[0].major;
  const local = localNodeMajor();
  if (local && declaredMajor && local !== declaredMajor) {
    findings.push({
      level: 'warn',
      class: 'node-local-vs-ci',
      title: `Your local Node (${local}.x) differs from the version CI/config expects (${declaredMajor}.x)`,
      detail:
        'Your local runs pass on a different Node major than CI runs. Version-sensitive failures (new syntax, removed APIs, dependency engine ranges) will only show up in CI.',
      evidence: [`local: node ${local}.x`, ...pinned.map((s) => `${s.where}: Node ${s.major}.x`)],
      fix: `Switch locally: \`nvm use ${declaredMajor}\` (or \`fnm use\`), or update the pinned version if ${local}.x is intended.`,
    });
  }
}

// packageManager field (Corepack) vs the setup step used in CI.
function checkPackageManagerDrift(root, workflows, findings) {
  const pkgRaw = readFile(root, 'package.json');
  if (!pkgRaw) return;
  let pkg;
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    return;
  }
  const pm = pkg.packageManager;
  if (!pm || typeof pm !== 'string') return;
  const tool = pm.split('@')[0];
  if (!tool) return;

  // Which lockfile is present locally?
  const lockByTool = {
    pnpm: 'pnpm-lock.yaml',
    yarn: 'yarn.lock',
    npm: 'package-lock.json',
    bun: 'bun.lockb',
  };
  const expectedLock = lockByTool[tool];
  if (expectedLock && !fs.existsSync(path.join(root, expectedLock))) {
    findings.push({
      level: 'warn',
      class: 'package-manager-drift',
      title: `package.json declares packageManager "${pm}" but ${expectedLock} is missing`,
      detail:
        'CI enabling Corepack will use ' +
        tool +
        ", but the matching lockfile isn't committed — installs resolve differently than your local run.",
      evidence: [`packageManager: ${pm}`, `missing: ${expectedLock}`],
      fix: `Commit ${expectedLock} generated by ${tool}, or fix the packageManager field to match the tool you actually use.`,
    });
  }
}

module.exports = { checkNodeDrift, checkPackageManagerDrift };
