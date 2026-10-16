// Availability checks for name candidates: deterministic lookups, not the model's opinion.
// "free" only on a clear not-found, "taken" on a clear hit, "?" whenever a lookup fails.
import { candidates } from './stages.mjs';

const TIMEOUT_MS = 10_000;
export const slugOf = name => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function httpStatus(fetchImpl, url) {
  try { return (await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })).status; } catch { return null; }
}
const byStatus = s => (s === 404 ? 'free' : s === 200 ? 'taken' : '?');

function githubRepo(run, owner, slug) {
  try { run(['api', `repos/${owner}/${slug}`, '--jq', '.full_name']); return 'taken'; } catch (e) {
    return /\b404\b|Not Found/.test(`${e.message} ${e.stderr ?? ''}`) ? 'free' : '?';
  }
}

/** One candidate's availability: { name, slug, com, dev, npm, github }. */
export async function checkName(name, { fetchImpl = fetch, run, owner }) {
  const slug = slugOf(name);
  const [com, dev, npm] = await Promise.all([
    httpStatus(fetchImpl, `https://rdap.org/domain/${slug.replace(/-/g, '')}.com`),
    httpStatus(fetchImpl, `https://rdap.org/domain/${slug.replace(/-/g, '')}.dev`),
    httpStatus(fetchImpl, `https://registry.npmjs.org/${slug}`),
  ]);
  return { name, slug, com: byStatus(com), dev: byStatus(dev), npm: byStatus(npm), github: githubRepo(run, owner, slug) };
}

const AVAILABILITY = /\n## Availability[\s\S]*?(?=\n## |$)/;
const tmLinks = name => `[EUIPO](https://euipo.europa.eu/eSearch/#basic/1+1+1+1/${encodeURIComponent(name)}) · [USPTO](https://tmsearch.uspto.gov/search/search-results?query=${encodeURIComponent(name)})`;

/** naming.md with an "Availability" section (replaced on each run) for every candidate. */
export async function addAvailability(text, opts) {
  const results = [];
  for (const name of candidates(text)) results.push(await checkName(name, opts));
  const rows = results.map(r => `| ${r.name} | \`${r.slug}\` | ${r.com} | ${r.dev} | ${r.npm} | ${r.github} | ${tmLinks(r.name)} |`);
  const section = `\n## Availability\nChecked by productivity-os (RDAP, npm registry, \`gh\`). "?" means the lookup failed, so check it yourself. Trademarks: search the links.\n\n| Name | Slug | .com | .dev | npm | GitHub (${opts.owner}) | Trademark |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
  const base = AVAILABILITY.test(text) ? text.replace(AVAILABILITY, '') : text;
  return { text: `${base.trimEnd()}\n${section}`, results };
}
