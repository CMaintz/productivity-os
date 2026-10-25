/** What a `claude -p` run spent, from its JSON result. total_cost_usd is the API price; on a subscription nothing is billed. */
export const spentOf = out => {
  const u = out.usage ?? {};
  const n = v => Number(v) || 0;
  return { usd: n(out.total_cost_usd), input: n(u.input_tokens) + n(u.cache_creation_input_tokens), output: n(u.output_tokens), cached: n(u.cache_read_input_tokens), ms: n(out.duration_ms) };
};

/** Adds a finished run's spend to the running total on `holder` (a forge, its build, or a ticket). */
export function addSpend(holder, s) {
  if (!s?.spent) return;
  const t = (holder.spent ??= { usd: 0, input: 0, output: 0, cached: 0, ms: 0, runs: 0 });
  for (const k of ['usd', 'input', 'output', 'cached', 'ms']) t[k] = (t[k] ?? 0) + s.spent[k];
  t.runs += 1;
}
