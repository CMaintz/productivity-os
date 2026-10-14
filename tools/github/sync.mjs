#!/usr/bin/env node
// Pulls GitHub state into the vault's project notes: default-branch CI, open PRs (CI and
// review state), Foundry agent tickets and open issues. Only notes with a `repo:` are synced.
// Needs the `gh` CLI, logged in (`gh auth login`). Read-only on GitHub.
//
// Usage: node tools/github/sync.mjs [--vault <dir>] [--only <owner/name>]
// Vault: --vault, else $PRODUCTIVITY_VAULT, else ~/Vault.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { REPO_QUERY, GH_BLOCK, summarise, githubBlock, githubFields } from './github.mjs';
import { replaceBlock } from '../vault/projects.mjs';
import { setFrontmatter } from '../lib/frontmatter.mjs';

function parseArgs(argv) {
  const a = { vault: process.env.PRODUCTIVITY_VAULT || path.join(os.homedir(), 'Vault'), only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vault') a.vault = argv[++i];
    else if (argv[i] === '--only') a.only = argv[++i].toLowerCase();
  }
  return a;
}

/** Default fetcher: one GraphQL call per repo through the gh CLI. */
export function ghFetch(repo) {
  const [owner, name] = repo.split('/');
  const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${REPO_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out).data.repository;
}

/** Project notes that name a repo, as { file, repo }. */
export function notesWithRepo(vault) {
  const dir = path.join(vault, 'Projects');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const file = path.join(dir, f);
    const repo = fs.readFileSync(file, 'utf8').match(/^repo:\s*([\w.-]+\/[\w.-]+)\s*$/m)?.[1];
    return repo ? { file, repo } : null;
  }).filter(Boolean);
}

export function applyToNote(note, summary, syncedAt) {
  let out = note;
  for (const [k, v] of Object.entries(githubFields(summary, syncedAt))) out = setFrontmatter(out, k, v);
  return replaceBlock(out, GH_BLOCK, githubBlock(summary, syncedAt));
}

/** Syncs every matching note; one failing repo (renamed, deleted, no access) doesn't stop the rest. */
export function syncVault(vault, { only = null, fetch = ghFetch, now = new Date() } = {}) {
  const syncedAt = now.toISOString();
  const result = { updated: [], failed: [] };
  for (const { file, repo } of notesWithRepo(vault).filter(n => !only || n.repo.toLowerCase() === only)) {
    try {
      const data = fetch(repo);
      if (!data) throw new Error('not found');
      fs.writeFileSync(file, applyToNote(fs.readFileSync(file, 'utf8'), summarise(data), syncedAt));
      result.updated.push(repo);
    } catch (e) {
      result.failed.push({ repo, error: String(e.stderr || e.message).trim().split('\n')[0] });
    }
  }
  return result;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  try { execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }); } catch {
    console.error('The gh CLI is missing or not logged in. Install it and run `gh auth login`.'); process.exit(1);
  }
  const r = syncVault(a.vault, { only: a.only });
  console.log(`GitHub sync: ${r.updated.length} project notes updated, ${r.failed.length} failed`);
  r.failed.forEach(f => console.log(`  ✗ ${f.repo}: ${f.error}`));
}

if (process.argv[1] && path.basename(process.argv[1]) === 'sync.mjs') main();
