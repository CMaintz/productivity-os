#!/usr/bin/env node
// Ratcheted `npm audit` for the foundry `audit` verb.
//
// `npm audit --audit-level=critical` has no way to accept a *specific* unfixable
// advisory - it's all-or-nothing, so a repo with one pre-existing critical either
// reds every PR or silences the whole check. Neither is acceptable (foundry:
// "accept that specific CVE with justification - never silence the whole check").
//
// This wraps npm audit with a shrink-only allowlist, exactly like eslint
// suppressions or the habit-hooks snooze baseline:
//   - FAIL on any critical whose package is NOT in the allowlist  (no new debt)
//   - FAIL on any allowlist entry that is no longer present       (stale ⇒ prune it)
//   - PASS otherwise, printing the accepted set for visibility
//
// Usage:  npm audit --json | node scripts/npm-audit-ratchet.mjs [--level=critical] [--allowlist=.audit-allowlist.json]
// Reads the `npm audit --json` report from stdin - the caller pipes it in, so `npm`
// resolves in the caller's shell (mise-invoking-execSync-invoking-npm.cmd was flaky
// on Windows). npm audit exits non-zero when it finds anything, but still writes the
// JSON to stdout, so the pipe (with pipefail off) delivers the report regardless.
import { readFileSync, existsSync } from 'node:fs';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const level = arg('level', 'critical');
const allowlistPath = arg('allowlist', '.audit-allowlist.json');

// Read the report from stdin (fd 0). The mise `audit` task pipes `npm audit --json` in.
let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}
if (!raw.trim()) {
  console.error('npm-audit-ratchet: no audit JSON on stdin - pipe it in:\n  npm audit --json | node scripts/npm-audit-ratchet.mjs');
  process.exit(2);
}

const report = JSON.parse(raw);
const vulns = report.vulnerabilities || {};
// Packages at (or above) the gate level. npm severities: low < moderate < high < critical.
const order = ['low', 'moderate', 'high', 'critical'];
const floor = order.indexOf(level);
const flagged = Object.entries(vulns)
  .filter(([, v]) => order.indexOf(v.severity) >= floor)
  .map(([name, v]) => ({
    name,
    severity: v.severity,
    urls: [...new Set((function collect(via, acc = []) {
      for (const x of via || []) if (x && typeof x === 'object' && x.url) acc.push(x.url);
      return acc;
    })(v.via))],
  }));

// Allowlist - accepted[].package is the vulnerable package name; reason is required.
let accepted = [];
if (existsSync(allowlistPath)) {
  const al = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  accepted = al.accepted || [];
  const missingReason = accepted.filter((e) => !e.package || !e.reason);
  if (missingReason.length) {
    console.error(`npm-audit-ratchet: every allowlist entry needs {package, reason}; bad: ${JSON.stringify(missingReason)}`);
    process.exit(2);
  }
}
const acceptedNames = new Set(accepted.map((e) => e.package));
const flaggedNames = new Set(flagged.map((f) => f.name));

const unaccepted = flagged.filter((f) => !acceptedNames.has(f.name));
const stale = accepted.filter((e) => !flaggedNames.has(e.package));

if (accepted.length) {
  console.log(`Accepted (${level}+) debt - baselined, must shrink:`);
  for (const e of accepted) console.log(`  • ${e.package} - ${e.reason}`);
  console.log('');
}

let ok = true;
if (unaccepted.length) {
  ok = false;
  console.error(`❌ ${unaccepted.length} un-accepted ${level}+ advisory(ies):`);
  for (const f of unaccepted) console.error(`  • ${f.name} [${f.severity}]  ${f.urls.join(' ')}`);
  console.error('\nFix it (npm audit fix), or if genuinely unfixable now, add {package, reason} to');
  console.error(`${allowlistPath} with justification. Never silence the whole check.`);
}
if (stale.length) {
  ok = false;
  console.error(`\n❌ ${stale.length} stale allowlist entry(ies) - the advisory is gone, so PRUNE it (ratchets only shrink):`);
  for (const e of stale) console.error(`  • ${e.package}`);
}
if (ok) console.log(`✅ audit ok - no un-accepted ${level}+ advisories.`);
process.exit(ok ? 0 : 1);
