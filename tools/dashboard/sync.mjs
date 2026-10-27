#!/usr/bin/env node
// Two-way link between the vault (on the main PC) and the dashboard's Supabase project:
//   push: upserts the metadata snapshot (snapshot.mjs) for the owner
//   pull: applies dashboard button presses (card_events) to the card notes, the same
//         fields the Meta Bind buttons set, then marks each event applied; reads code
//         widget crash reports (widget_errors) and switches repeat offenders off
// The executor calls both on every pass when the dashboard is configured.
//
// Config: ~/.productivity-os/dashboard.json, which lives outside the vault so it never syncs:
//   { "url": "https://<ref>.supabase.co", "serviceKey": "<service_role key>", "ownerId": "<auth user uuid>" }
// Usage: node tools/dashboard/sync.mjs [--vault <dir>]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildSnapshot } from './snapshot.mjs';
import { listCards, updateCard } from '../actions/cards.mjs';
import { applyWidgetErrors } from '../widgets/code-widgets.mjs';
import { writeFileAtomic } from '../lib/atomic-write.mjs';

export const CONFIG_FILE = path.join(os.homedir(), '.productivity-os', 'dashboard.json');

/** The config, or null when it's missing or unusable (a broken file must not stop the executor). */
export function loadConfig(file = CONFIG_FILE) {
  if (!fs.existsSync(file)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return c.url && c.serviceKey && c.ownerId ? c : null;
  } catch (e) {
    console.error(`dashboard: ignoring ${file}: ${e.message}`);
    return null;
  }
}

const TIMEOUT_MS = 20_000;

/** Minimal PostgREST client with the service role key (bypasses RLS; stays on this PC). */
export function rest(config, fetchImpl = fetch) {
  const base = `${config.url.replace(/\/$/, '')}/rest/v1`;
  const headers = { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' };
  return async (method, pathAndQuery, body, extra = {}) => {
    const res = await fetchImpl(`${base}${pathAndQuery}`, { method, headers: { ...headers, ...extra }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${method} ${pathAndQuery} -> ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  };
}

export async function push(vault, config, call, now = new Date()) {
  const data = buildSnapshot(vault, { now, host: os.hostname() });
  await call('POST', '/snapshot?on_conflict=owner_id', [{ owner_id: config.ownerId, data, updated_at: now.toISOString() }], { prefer: 'resolution=merge-duplicates,return=minimal' });
  return data;
}

// A press only applies to a card that's still waiting on that decision.
const ALLOWED_FROM = { approved: ['pending', 'snoozed'], snoozed: ['pending'], rejected: ['pending', 'snoozed'], undone: ['done', 'approved'] };

function applyEvent(vault, cards, e) {
  const card = cards.find(c => path.relative(vault, c.file).replace(/\\/g, '/') === e.card_file && c.key === e.card_key);
  if (!card) return 'card not found';
  if (!ALLOWED_FROM[e.status]?.includes(card.status)) return `ignored: card is ${card.status}`;
  // A fresh decision: clear what a snooze recorded, so the executor books it (ledger, trust ladder, never list).
  const fields = { status: e.status, ...(e.status === 'undone' ? {} : { decided_at: '', decided_by: '' }) };
  if (e.always) fields.always = true;
  if (e.never) fields.never = true;
  if (e.reason) fields.decline_reason = e.reason;
  writeFileAtomic(card.file, updateCard(card.text, fields));
  card.status = e.status;
  return 'applied';
}

export async function pull(vault, config, call, now = new Date()) {
  const events = await call('GET', `/card_events?owner_id=eq.${config.ownerId}&applied_at=is.null&order=id.asc&limit=100`);
  const cards = listCards(vault);
  const out = [];
  for (const e of events ?? []) {
    const outcome = applyEvent(vault, cards, e);
    await call('PATCH', `/card_events?id=eq.${e.id}`, { applied_at: now.toISOString(), outcome }, { prefer: 'return=minimal' });
    out.push({ id: e.id, outcome });
  }
  return out;
}

const ERROR_KEEP_DAYS = 7;

/** Recent code-widget crash reports: switches off repeat offenders, prunes old reports. */
export async function pullWidgetErrors(vault, config, call, now = new Date()) {
  const since = new Date(now.valueOf() - 864e5).toISOString();
  const errors = await call('GET', `/widget_errors?owner_id=eq.${config.ownerId}&created_at=gt.${since}&select=widget_id,message,created_at&order=created_at.desc&limit=500`);
  const off = applyWidgetErrors(vault, (errors ?? []).reverse(), now);
  const old = new Date(now.valueOf() - ERROR_KEEP_DAYS * 864e5).toISOString();
  await call('DELETE', `/widget_errors?owner_id=eq.${config.ownerId}&created_at=lt.${old}`, undefined, { prefer: 'return=minimal' });
  return off;
}

/** pull then push; never throws (the executor must keep running offline). */
export async function syncDashboard(vault, { config, fetchImpl = fetch, now = new Date() } = {}) {
  try {
    config = config === undefined ? loadConfig() : config;
    if (!config) return { skipped: 'not configured' };
    const call = rest(config, fetchImpl);
    const applied = await pull(vault, config, call, now);
    const disabled = await pullWidgetErrors(vault, config, call, now);
    await push(vault, config, call, now);
    return { applied, disabled };
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  const i = process.argv.indexOf('--vault');
  const vault = i > 0 ? process.argv[i + 1] : process.env.PRODUCTIVITY_VAULT || path.join(os.homedir(), 'Vault');
  const r = await syncDashboard(vault);
  if (r.skipped) console.log(`dashboard: ${r.skipped} (${CONFIG_FILE})`);
  else if (r.error) {
    console.error(`dashboard: ${r.error}`);
    process.exit(1);
  } else console.log(`dashboard: snapshot pushed, ${r.applied.length} button press(es) applied`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'sync.mjs') main();
