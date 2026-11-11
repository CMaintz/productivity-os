#!/usr/bin/env node
// Claude Code status line that records your subscription usage for the Product Forge's pacing.
// Claude Code pipes a JSON status to it (after each reply, and every refreshInterval seconds);
// its `rate_limits` (5-hour and 7-day windows, Pro/Max only) go to <vault>/_system/usage.json.
// With --chain <base64 JSON { command }>, your previous status line runs on the same input and its
// output is what you see; otherwise a short usage line is printed. Never fails the status line.
// Vault: $PRODUCTIVITY_VAULT, else ~/Vault.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { writeFileAtomic } from '../lib/atomic-write.mjs';

const iso = epochSeconds => (Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString() : null);
const pct = v => (Number.isFinite(v) ? v : null);

/** The usage record from a status payload, or null when it carries no rate limits. */
export function usageFromStatus(status, now = new Date()) {
  const five = status?.rate_limits?.five_hour;
  const week = status?.rate_limits?.seven_day;
  if (!five && !week) return null;
  const fuller = (pct(week?.used_percentage) ?? -1) > (pct(five?.used_percentage) ?? -1) ? week : five;
  return { fiveHourPct: pct(five?.used_percentage), weeklyPct: pct(week?.used_percentage), resetsAt: iso(fuller?.resets_at), recordedAt: now.toISOString() };
}

const line = u => (u ? `5h ${u.fiveHourPct ?? '?'}% · week ${u.weeklyPct ?? '?'}%` : '');

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let status = null;
  try { status = JSON.parse(raw); } catch { /* not JSON: nothing to record */ }
  const usage = usageFromStatus(status);
  const vault = process.env.PRODUCTIVITY_VAULT || path.join(os.homedir(), 'Vault');
  if (usage && fs.existsSync(path.join(vault, '_system'))) {
    try { writeFileAtomic(path.join(vault, '_system', 'usage.json'), JSON.stringify(usage) + '\n', { retryMs: 0 }); } catch { /* the status line must never break */ }
  }
  const i = process.argv.indexOf('--chain');
  if (i < 0) { process.stdout.write(`${line(usage)}\n`); return; }
  try {
    const { command } = JSON.parse(Buffer.from(process.argv[i + 1], 'base64').toString('utf8'));
    process.stdout.write(execSync(command, { input: raw, encoding: 'utf8', timeout: 5000 }));
  } catch (e) { process.stdout.write(String(e.stdout ?? '')); }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'statusline.mjs') main();
