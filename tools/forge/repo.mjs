// forge_create_repo: after you approve the card, the forge's plan becomes a private repo with
// the spec, stack ADR, plan and naming in docs/, Foundry's labels, an epic and one agent-feature
// issue per ticket, created in dependency order. Tickets with nothing to wait for get agent:ready;
// the rest wait for the build stage (slice 2) to release them.
//
// It's resumable: an existing repo is reused, docs are upserted, and every issue it creates is
// recorded in the forge note at once, so a retry after a partial failure never duplicates one.

import fs from 'node:fs';
import path from 'node:path';
import { fieldsOf, setFrontmatter } from '../lib/frontmatter.mjs';
import { readToolsConfig } from '../lib/tools-config.mjs';
import { createCard } from '../actions/cards.mjs';
import { createIssue, ensureLabels } from '../lib/gh.mjs';
import { FORGE_DIR, forgeNote, parsePlan, topoOrder } from './stages.mjs';
import { slugOf } from './naming.mjs';
import { writeFileAtomic } from '../lib/atomic-write.mjs';

const DEFAULT_OWNER = 'CMaintz';
const DOCS = [['spec.md', 'docs/spec.md'], ['decisions/0001-stack.md', 'docs/decisions/0001-stack.md'], ['plan.md', 'docs/plan.md'], ['naming.md', 'docs/naming.md']];
const PRODUCT_LABELS = ['agent-feature', 'agent:ready', 'agent:working', 'agent:blocked', 'epic'];

export const ownerOf = vault => readToolsConfig(vault).githubOwner || DEFAULT_OWNER;
const repoName = (vault, name) => `${ownerOf(vault)}/${slugOf(name)}`;

/** The always-asked card that turns the plan into a repo. Returns its key. */
export function proposeRepo(vault, f, now) {
  const name = f.name || f.slug;
  const repo = repoName(vault, name);
  const key = `forge-repo:${f.slug}:${now.toISOString().slice(0, 16)}`;
  createCard(vault, {
    action: 'forge_create_repo', key, risk: 'medium', title: `Forge ${name}: create the repo and tickets`,
    reason: `The plan is ready in ${FORGE_DIR}/${f.slug}/plan.md.`, context: `[[${FORGE_DIR}/${f.slug}/plan]]`,
    explain: `creates the private repo ${repo} with the spec, ADR and plan in docs/, Foundry's labels, an epic and one agent-feature issue per ticket (tickets without dependencies get agent:ready). To change the plan instead, press No with what to change.`,
    undo: `not automatic (deleting is yours to do): gh repo delete ${repo}`,
    params: { slug: f.slug, name, repo }, expiresDays: 14,
  }, now.toISOString());
  return key;
}

export function ticketBody(t, issueOf) {
  const deps = t.dependsOn.length ? t.dependsOn.map(d => `#${issueOf[d]}`).join(', ') : 'none';
  return `### Intent\n${t.intent}\n\n### Acceptance criteria\n${t.criteria}\n\n### Scope boundaries\n${t.scope}\n\n### Pointers\n${t.pointers}\n- docs/spec.md, docs/decisions/, docs/plan.md (T${t.n})\n\nDepends on: ${deps}\n`;
}

const issueNumber = url => Number(String(url).match(/\/issues\/(\d+)/)?.[1]);
const exists = (run, args) => { try { return run(args).trim() || 'yes'; } catch { return null; } };

/** Creates or updates each doc through the contents API, the JSON body on stdin (no argv size limit). */
function pushDocs(run, repo, dir) {
  for (const [from, to] of DOCS) {
    const file = path.join(dir, from);
    if (!fs.existsSync(file)) continue;
    const sha = exists(run, ['api', `repos/${repo}/contents/${to}`, '--jq', '.sha']);
    const body = { message: `docs: ${path.basename(to)} from the Product Forge`, content: fs.readFileSync(file).toString('base64'), ...(sha ? { sha } : {}) };
    run(['api', '-X', 'PUT', `repos/${repo}/contents/${to}`, '--input', '-'], JSON.stringify(body));
  }
}

/**
 * Changes to main only through PRs, so a worker can't push there directly. Best effort: GitHub
 * doesn't offer branch protection on private repos without a paid plan, and then this is skipped.
 */
function protectMain(run, repo) {
  const body = { required_status_checks: null, enforce_admins: false, required_pull_request_reviews: { required_approving_review_count: 0 }, restrictions: null };
  try { run(['api', '-X', 'PUT', `repos/${repo}/branches/main/protection`, '--input', '-'], JSON.stringify(body)); } catch { /* not available on this plan */ }
}

const record = (note, key, value) => writeFileAtomic(note, setFrontmatter(fs.readFileSync(note, 'utf8'), key, JSON.stringify(value)));

/** The handler: repo, docs, labels, tickets in dependency order, then the epic linking them. */
export function createForgeRepo(card, ctx) {
  const { slug, name, repo } = card.params;
  const note = forgeNote(ctx.vault, String(slug));
  const dir = path.join(ctx.vault, FORGE_DIR, String(slug));
  if (!/^[a-z0-9-]+$/.test(String(slug)) || !fs.existsSync(note) || !fs.existsSync(path.join(dir, 'plan.md'))) return { ok: false, summary: `No plan for forge "${slug}".` };
  if (repo !== repoName(ctx.vault, name)) return { ok: false, summary: 'The card no longer matches the forge; propose it again.' };
  const { tickets, problems } = parsePlan(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'));
  if (problems.length) return { ok: false, summary: `plan.md isn't ready: ${problems.join('; ')}` };
  if (!exists(ctx.gh, ['repo', 'view', repo, '--json', 'name'])) ctx.gh(['repo', 'create', repo, '--private', '--add-readme', '--description', `${name}, from the Product Forge`]);
  record(note, 'repo', `https://github.com/${repo}`);
  pushDocs(ctx.gh, repo, dir);
  protectMain(ctx.gh, repo);
  ensureLabels(ctx.gh, repo, PRODUCT_LABELS);
  const issueOf = { ...(fieldsOf(fs.readFileSync(note, 'utf8')).issues || {}) };
  for (const t of topoOrder(tickets).filter(x => !issueOf[x.n])) {
    const url = createIssue(ctx.gh, repo, { title: `T${t.n}: ${t.title}`, body: ticketBody(t, issueOf), labels: ['agent-feature', ...(t.dependsOn.length ? [] : ['agent:ready'])] });
    issueOf[t.n] = issueNumber(url);
    record(note, 'issues', issueOf);
  }
  let epic = fieldsOf(fs.readFileSync(note, 'utf8')).epic;
  if (!epic) {
    const list = tickets.map(t => `- [ ] #${issueOf[t.n]} T${t.n}: ${t.title}`).join('\n');
    epic = createIssue(ctx.gh, repo, { title: `epic: ${name} v1`, body: `Planned by the Product Forge. Spec, ADR and plan are in docs/.\n\n${list}\n`, labels: ['epic'] });
    record(note, 'epic', epic);
  }
  return { ok: true, summary: `${repo} has ${tickets.length} tickets and the epic ${epic}. Tickets without dependencies are labelled agent:ready.` };
}
