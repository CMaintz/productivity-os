import type { CodeWidget, Row } from '../../types';
import { ago } from '../../format';

const STATES = ['failing', 'pending', 'passing', 'none'];
const rank = (r: Row) => {
  const i = STATES.indexOf(String(r.ci ?? 'none'));
  return i < 0 ? STATES.length : i;
};

export const createWidget: CodeWidget = ({ h }) =>
  function CiStatus({ rows, ctx }) {
    if (!rows.length) return h('p', { class: 'empty' }, 'No projects with CI yet.');
    const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
    const failing = rows.filter(r => r.ci === 'failing').length;
    return h(
      'div',
      { class: 'ci-status' },
      h('p', { class: failing ? 'ci-summary bad' : 'ci-summary good' }, failing ? `${failing} failing` : 'All green'),
      h(
        'ul',
        { class: 'ci-list' },
        sorted.map(r =>
          h(
            'li',
            { key: String(r.slug), 'data-ci': String(r.ci ?? 'none') },
            h('span', { class: 'ci-dot', 'aria-hidden': 'true' }),
            h('span', { class: 'ci-name' }, String(r.slug ?? r.title ?? '')),
            h('span', { class: 'muted' }, `${String(r.ci ?? 'none')}${Number(r.failing_prs) ? ` · ${String(r.failing_prs)} PR failing` : ''} · ${ago(r.updated, ctx.now)}`),
          ),
        ),
      ),
    );
  };
