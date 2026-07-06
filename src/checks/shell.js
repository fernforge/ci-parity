'use strict';

const os = require('os');
const { steps } = require('../workflows');

// Patterns whose behavior differs between GNU/Linux (GitHub ubuntu runners) and BSD/macOS,
// or that only exist on one platform. Keyed by a short id with an explanation + portable fix.
const PORTABILITY_RULES = [
  {
    id: 'sed-i-inplace',
    re: /\bsed\s+-i(?!\.)(?!\s+(['"])\1)/,
    // GNU: `sed -i 's/.../'`. BSD/macOS reads the script as the backup suffix and needs `sed -i ''`.
    note: 'sed -i without an attached suffix is GNU-only; BSD/macOS sed requires `sed -i \'\'`',
    fix: "Use `sed -i.bak` (works on both) and delete the .bak, or run perl -i -pe.",
  },
  {
    id: 'readlink-f',
    re: /\breadlink\s+-f\b/,
    note: 'readlink -f is GNU-only; macOS readlink has no -f',
    fix: 'Use a portable realpath, or `python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))"`.',
  },
  {
    id: 'date-d',
    re: /\bdate\s+-d\b/,
    note: 'date -d (GNU relative dates) is not supported by BSD/macOS date',
    fix: 'Avoid GNU date arithmetic in shared scripts, or shell out to node/python for dates.',
  },
  {
    id: 'grep-P',
    re: /\bgrep\s+(-[a-zA-Z]*P|--perl-regexp)\b/,
    note: 'grep -P (PCRE) is GNU-only; macOS BSD grep lacks it',
    fix: 'Use grep -E with an ERE pattern, or ripgrep.',
  },
  {
    id: 'gnu-stat',
    re: /\bstat\s+-c\b/,
    note: 'stat -c is GNU format; macOS uses stat -f',
    fix: 'Avoid stat format flags in shared scripts, or branch on the OS.',
  },
];

function detectLinux(runsOn) {
  const s = Array.isArray(runsOn) ? runsOn.join(' ') : String(runsOn || '');
  return /ubuntu|linux/i.test(s);
}

function checkShellPortability(root, workflows, findings) {
  const localPlatform = os.platform(); // 'darwin' | 'win32' | 'linux'
  const hits = [];

  for (const wf of workflows) {
    if (!wf.doc) continue;
    for (const { step, jobId, runsOn } of steps(wf.doc)) {
      const run = typeof step.run === 'string' ? step.run : '';
      if (!run) continue;
      const linuxRunner = detectLinux(runsOn);
      for (const rule of PORTABILITY_RULES) {
        if (rule.re.test(run)) {
          hits.push({ rule, jobId, wf: wf.name, linuxRunner, snippet: firstMatchingLine(run, rule.re) });
        }
      }
    }
  }

  if (hits.length === 0) return;

  // Only actionable as a *local-vs-CI* warning when the developer is not on Linux.
  const localIsLinux = localPlatform === 'linux';
  const level = localIsLinux ? 'info' : 'warn';

  const seen = new Set();
  const evidence = [];
  for (const h of hits) {
    const key = `${h.wf}:${h.rule.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push(`${h.wf} (${h.jobId}): ${h.rule.note}\n      ${h.snippet}`);
  }

  findings.push({
    level,
    class: 'shell-portability',
    title: localIsLinux
      ? `${evidence.length} platform-specific shell command${evidence.length === 1 ? '' : 's'} in your workflows`
      : `${evidence.length} workflow shell command${evidence.length === 1 ? '' : 's'} behave differently on your ${localPlatform === 'darwin' ? 'macOS' : localPlatform} machine than on the Linux CI runner`,
    detail: localIsLinux
      ? 'These run fine on the ubuntu runner but break for contributors on macOS/Windows running the same scripts locally.'
      : 'You run these locally on a non-Linux OS where they behave differently (or fail), while CI runs them on GNU/Linux. A green local run does not mean CI is green, or vice versa.',
    evidence,
    fix: 'Use the portable form noted for each, or move the logic into a node/python script that behaves identically everywhere.',
  });
}

function firstMatchingLine(run, re) {
  const line = run.split('\n').find((l) => re.test(l));
  return (line || '').trim().slice(0, 120);
}

module.exports = { checkShellPortability };
