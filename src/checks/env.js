'use strict';

const fs = require('fs');
const path = require('path');
const { steps } = require('../workflows');

// Parse the KEY names out of a .env file (values ignored).
function envFileKeys(root) {
  const keys = new Set();
  for (const name of ['.env', '.env.local', '.env.test', '.env.development']) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(root, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}

// Collect env var names a workflow references via `env:` -> ${{ secrets.X }} / ${{ vars.X }}
// but that a test/build step then consumes as $NAME.
function checkMissingEnv(root, workflows, findings) {
  const localKeys = envFileKeys(root);
  const referenced = new Map(); // NAME -> { origin: 'secrets'|'vars', where }

  for (const wf of workflows) {
    if (!wf.doc) continue;
    for (const { step, jobId } of steps(wf.doc)) {
      const envBlock = step.env && typeof step.env === 'object' ? step.env : {};
      for (const [k, v] of Object.entries(envBlock)) {
        const val = String(v);
        const sm = val.match(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/);
        const vm = val.match(/\$\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/);
        if (sm || vm) {
          referenced.set(k, {
            origin: sm ? 'secrets' : 'vars',
            secretName: (sm || vm)[1],
            where: `${wf.name} (${jobId})`,
          });
        }
      }
    }
  }

  if (referenced.size === 0) return;

  const missing = [];
  for (const [name, info] of referenced) {
    if (!localKeys.has(name) && !(name in process.env)) {
      missing.push({ name, ...info });
    }
  }

  if (missing.length > 0) {
    findings.push({
      level: 'warn',
      class: 'env-missing-locally',
      title: `${missing.length} env var${missing.length === 1 ? '' : 's'} your workflow injects ${missing.length === 1 ? 'is' : 'are'} absent locally`,
      detail:
        'Your workflow supplies these from CI secrets/vars. If a test or build reads them, it can pass on your machine only because it silently falls back (or is skipped), then behave differently in CI — or the reverse.',
      evidence: missing.map((m) => `${m.name} <- ${m.origin}.${m.secretName} (${m.where}); not in your shell or .env`),
      fix: 'Add the names (with test-safe values) to a local .env, or gate the code on their presence so local and CI take the same path.',
    });
  }
}

module.exports = { checkMissingEnv };
