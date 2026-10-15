// forge_create_repo: after you approve the card, the forge's plan becomes a private repo with
// the spec, stack ADR and plan in docs/, Foundry's labels, an epic and one agent-feature issue
// per ticket, created in dependency order. Tickets with nothing to wait for get agent:ready;
// the rest wait for the build stage (slice 2) to release them.

import fs from 'node:fs';
import path from 'node:path';
import { setFrontmatter } from '../lib/frontmatter.mjs';
import { readToolsConfig } from '../lib/tools-config.mjs';
import { createIssue, ensureLabels } from '../lib/gh.mjs';
import { parsePlan, topoOrder } from './stages.mjs';
import { slugOf } from './naming.mjs';

const DEFAULT_OWNER = 'CMaintz';
const DOCS = [['spec.md', 'docs/spec.md'], ['decisions/0001-stack.md', 'docs/decisions/0001-stack.md'], ['plan.md', 'docs/plan.md'], ['naming.md', 'docs/naming.md']];

export const ownerOf = vault => readToolsConfig(vault).githubOwner || DEFAULT_OWNER;

export function ticketBody(t, issueOf) {
  const deps = t.dependsOn.length ? t.dependsOn.map(d => `#${issueOf.get(d)}`).join(', ') : 'none';
  return `### Intent\n${t.intent}\n\n### Acceptance criteria\n${t.criteria}\n\n### Scope boundaries\n${t.scope}\n\n### Pointers\n${t.pointers}\n- docs/spec.md, docs/decisions/, docs/plan.md (T${t.n})\n\nDepends on: ${deps}\n`;
}

const issueNumber = url => Number(String(url).match(/\/issues\/(\d+)/)?.[1]);

function pushDocs(run, repo, dir) {
  for (const [from, to] of DOCS) {
    const file = path.join(dir, from);
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file).toString('base64');
    run(['api', '-X', 'PUT', `repos/${repo}/contents/${to}`, '-f', `message=docs: ${path.basename(to)} from the Product Forge`, '-f', `content=${content}`]);
  }
}

/** The handler: repo, docs, labels, tickets in dependency order, then the epic linking them. */
export function createForgeRepo(card, ctx) {
  const { slug, name, owner } = card.params;
  const dir = path.join(ctx.vault, 'Forge', String(slug));
  if (!/^[a-z0-9-]+$/.test(String(slug)) || !fs.existsSync(path.join(dir, 'plan.md'))) return { ok: false, summary: `No plan for forge "${slug}".` };
  const { tickets, problems } = parsePlan(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'));
  if (problems.length) return { ok: false, summary: `plan.md isn't ready: ${problems.join('; ')}` };
  const repo = `${owner}/${slugOf(name)}`;
  ctx.gh(['repo', 'create', repo, '--private', '--add-readme', '--description', `${name}, from the Product Forge`]);
  pushDocs(ctx.gh, repo, dir);
  ensureLabels(ctx.gh, repo);
  const issueOf = new Map();
  for (const t of topoOrder(tickets)) {
    const url = createIssue(ctx.gh, repo, { title: `T${t.n}: ${t.title}`, body: ticketBody(t, issueOf), labels: t.dependsOn.length ? [] : ['agent:ready'] });
    issueOf.set(t.n, issueNumber(url));
  }
  const list = tickets.map(t => `- [ ] #${issueOf.get(t.n)} T${t.n}: ${t.title}`).join('\n');
  const epic = createIssue(ctx.gh, repo, { title: `epic: ${name} v1`, body: `Planned by the Product Forge. Spec, ADR and plan are in docs/.\n\n${list}\n`, labels: ['epic'] });
  const forgeFile = path.join(dir, 'forge.md');
  fs.writeFileSync(forgeFile, setFrontmatter(fs.readFileSync(forgeFile, 'utf8'), 'repo', JSON.stringify(`https://github.com/${repo}`)));
  return { ok: true, summary: `Created ${repo} with ${tickets.length} tickets and the epic ${epic}. Tickets without dependencies are labelled agent:ready.` };
}
