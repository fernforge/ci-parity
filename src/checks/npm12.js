'use strict';

const fs = require('fs');
const path = require('path');

function read(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

function readJson(root, rel) {
  const raw = read(root, rel);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// npm v12 (2026-07-08) defaults allow-scripts / allow-git / allow-remote to deny.
// A package-lock.json v2/v3 records which resolved packages carry lifecycle scripts
// (hasInstallScript: true) and what each dependency's resolved source actually is
// (git+, github:, or a bare tarball URL) -- both are statically knowable with no install.

function collectInstallScriptPackages(lock) {
  const names = [];
  if (!lock || !lock.packages || typeof lock.packages !== 'object') return names;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || !entry || entry.hasInstallScript !== true) continue;
    const m = key.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
    names.push(m ? m[1] : key);
  }
  return names;
}

function collectNonRegistrySources(pkg, lock) {
  const declared = {
    ...(pkg && pkg.dependencies),
    ...(pkg && pkg.devDependencies),
    ...(pkg && pkg.optionalDependencies),
  };
  const git = [];
  const remote = [];

  for (const [name, spec] of Object.entries(declared)) {
    if (typeof spec !== 'string') continue;
    if (/^git\+|^git:|^github:|^gitlab:|^bitbucket:/.test(spec)) {
      git.push(`${name}@${spec}`);
    } else if (/^https?:\/\//.test(spec)) {
      remote.push(`${name}@${spec}`);
    }
  }

  // Cross-check the lockfile's resolved sources too -- catches transitive git/tarball deps
  // that a direct dependency pulls in, not just top-level package.json entries.
  if (lock && lock.packages && typeof lock.packages === 'object') {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key === '' || !entry || typeof entry.resolved !== 'string') continue;
      const m = key.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
      const name = m ? m[1] : key;
      if (/^git\+/.test(entry.resolved)) {
        if (!git.some((g) => g.startsWith(name + '@'))) git.push(`${name} (${entry.resolved})`);
      } else if (/^https?:\/\//.test(entry.resolved) && !/registry\.npmjs\.org/.test(entry.resolved)) {
        if (!remote.some((r) => r.startsWith(name + '@'))) remote.push(`${name} (${entry.resolved})`);
      }
    }
  }

  return { git, remote };
}

function hasAllowScriptsConfig(root) {
  const npmrc = read(root, '.npmrc') || '';
  if (/^\s*allow-scripts\s*=/m.test(npmrc)) return true;
  const pkg = readJson(root, 'package.json');
  if (pkg && pkg.npm && pkg.npm.allowScripts) return true;
  return fs.existsSync(path.join(root, '.npm-allow-scripts.json'));
}

// npm v12 also defaults allow-git / allow-remote to "none" unless a project opts in.
function hasAllowGitOrRemoteConfig(root) {
  const npmrc = read(root, '.npmrc') || '';
  return /^\s*allow-(git|remote)\s*=/m.test(npmrc);
}

function checkNpm12DefaultBlock(root, workflows, findings) {
  const pkg = readJson(root, 'package.json');
  const lock = readJson(root, 'package-lock.json');
  if (!pkg && !lock) return;

  const scripted = collectInstallScriptPackages(lock);
  if (scripted.length > 0 && !hasAllowScriptsConfig(root)) {
    findings.push({
      level: 'error',
      class: 'npm12-blocked-install-scripts',
      title: `${scripted.length} dependenc${scripted.length === 1 ? 'y has' : 'ies have'} lifecycle install scripts that npm 12 will skip by default`,
      detail:
        'npm 12 (shipped 2026-07-08) defaults allow-scripts to deny: postinstall/preinstall scripts no longer run unless approved. A CI runner on npm 12+ will silently skip these -- native builds and postinstall setup steps go missing, often without a hard failure.',
      evidence: [
        `has install scripts: ${scripted.slice(0, 8).join(', ')}${scripted.length > 8 ? ` (+${scripted.length - 8} more)` : ''}`,
        'no allow-scripts config found (.npmrc, package.json "npm.allowScripts", or .npm-allow-scripts.json)',
      ],
      fix: 'Run `npm approve-scripts` (or set `allow-scripts=<pkg>:true` in .npmrc) for each dependency that needs its install script, then commit the allowlist.',
    });
  }

  const { git, remote } = collectNonRegistrySources(pkg, lock);
  if ((git.length > 0 || remote.length > 0) && !hasAllowGitOrRemoteConfig(root)) {
    if (git.length > 0) {
      findings.push({
        level: 'error',
        class: 'npm12-blocked-git-dep',
        title: `${git.length} dependenc${git.length === 1 ? 'y resolves' : 'ies resolve'} via git, which npm 12 blocks by default`,
        detail:
          'npm 12 defaults allow-git to "none": installing a git-protocol dependency now fails outright instead of cloning it, unless the project opts in.',
        evidence: git.slice(0, 8),
        fix: 'Set `allow-git=all` (or list specific specs) in .npmrc, or replace the git dependency with a registry-published package.',
      });
    }
    if (remote.length > 0) {
      findings.push({
        level: 'error',
        class: 'npm12-blocked-remote-dep',
        title: `${remote.length} dependenc${remote.length === 1 ? 'y resolves' : 'ies resolve'} via a remote tarball URL, which npm 12 blocks by default`,
        detail:
          'npm 12 defaults allow-remote to "none": a bare https:// tarball dependency now fails to install instead of downloading it, unless the project opts in.',
        evidence: remote.slice(0, 8),
        fix: 'Set `allow-remote=all` in .npmrc, or replace the tarball URL dependency with a registry-published package.',
      });
    }
  }
}

module.exports = { checkNpm12DefaultBlock };
