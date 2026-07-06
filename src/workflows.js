'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Find and parse .github/workflows/*.yml|*.yaml under the repo root.
function loadWorkflows(root) {
  const dir = path.join(root, '.github', 'workflows');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const file = path.join(dir, name);
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      out.push({ file, name, parseError: err.message, doc: null });
      continue;
    }
    if (doc && typeof doc === 'object') out.push({ file, name, doc });
  }
  return out;
}

// Yield every step across every job of a parsed workflow doc.
function* steps(doc) {
  const jobs = doc && doc.jobs;
  if (!jobs || typeof jobs !== 'object') return;
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object') continue;
    const runsOn = job['runs-on'];
    const jobSteps = Array.isArray(job.steps) ? job.steps : [];
    for (const step of jobSteps) {
      if (step && typeof step === 'object') yield { jobId, runsOn, step, job };
    }
  }
}

module.exports = { loadWorkflows, steps };
