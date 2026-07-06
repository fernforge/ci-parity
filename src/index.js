'use strict';

const { loadWorkflows } = require('./workflows');
const { checkNodeDrift, checkPackageManagerDrift } = require('./checks/versions');
const { checkLockfileStaleness } = require('./checks/lockfile');
const { checkMissingEnv } = require('./checks/env');
const { checkShellPortability } = require('./checks/shell');

// Run every static check against a repo root. Returns { findings, workflowCount, parseErrors }.
function analyze(root) {
  const workflows = loadWorkflows(root);
  const findings = [];
  const parseErrors = [];

  for (const wf of workflows) {
    if (wf.parseError) {
      parseErrors.push({ file: wf.name, error: wf.parseError });
      findings.push({
        level: 'error',
        class: 'workflow-parse-error',
        title: `Workflow ${wf.name} is not valid YAML`,
        detail: 'GitHub will reject or skip this workflow. It cannot run at all.',
        evidence: [wf.parseError.split('\n')[0]],
        fix: 'Fix the YAML syntax in .github/workflows/' + wf.name + '.',
      });
    }
  }

  checkNodeDrift(root, workflows, findings);
  checkPackageManagerDrift(root, workflows, findings);
  checkLockfileStaleness(root, workflows, findings);
  checkMissingEnv(root, workflows, findings);
  checkShellPortability(root, workflows, findings);

  return { findings, workflowCount: workflows.length, parseErrors };
}

module.exports = { analyze };
