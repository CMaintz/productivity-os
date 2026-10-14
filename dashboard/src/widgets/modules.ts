import type { Ctx, Host, Press, Row } from './types';
import { ago, plainLink } from './format';

const BUTTONS: [string, Press, string][] = [
  ['Do it', { status: 'approved' }, 'primary'],
  ['Not now', { status: 'snoozed' }, ''],
  ['No', { status: 'rejected' }, 'danger'],
  ['Always do this', { status: 'approved', always: true }, 'quiet'],
  ['Never suggest this', { status: 'rejected', never: true }, 'quiet'],
];
const UNDO: Press = { status: 'undone' };

export function modules({ h, useState }: Host) {
  function TodayView({ rows }: { rows: Row[] }) {
    const t = (rows[0] ?? {}) as { date?: string; top3?: string[]; openTasks?: number };
    const top3 = t.top3 ?? [];
    return h('div', null,
      h('p', { class: 'muted mono' }, t.date ?? ''),
      top3.length ? h('ol', { class: 'top3' }, top3.map((x, i) => h('li', { key: i }, x))) : h('p', { class: 'empty' }, 'No Top 3 yet. Run /today in the vault.'),
      h('p', { class: 'muted' }, `${t.openTasks ?? 0} open tasks`));
  }

  function CardButtons({ card, ctx }: { card: Row; ctx: Ctx }) {
    const [sent, setSent] = useState<string>('');
    const [failed, setFailed] = useState<string>('');
    const [reason, setReason] = useState<string>('');
    const press = ctx.press;
    if (!press) return null;
    const send = (label: string, p: Press) => press(card, p, reason).then(
      msg => { setFailed(''); setSent(msg || `Sent "${label}".`); },
      e => setFailed(`Couldn't send, try again: ${(e as Error).message}`));
    const done = card.status === 'done' || (card.status === 'approved' && card.decided_by === 'policy');
    const choices: [string, Press, string][] = done ? [['Undo', UNDO, 'quiet']] : BUTTONS;
    return h('div', null,
      h('div', { class: 'buttons' }, choices.map(([label, p, cls]) => h('button', { key: label, class: cls, disabled: !!sent, onClick: () => send(label, p) }, label))),
      done ? null : h('input', { class: 'reason', maxLength: 200, placeholder: 'why not? (optional)', 'aria-label': 'Reason', disabled: !!sent, value: reason, onInput: (e: Event) => setReason((e.target as HTMLInputElement).value) }),
      sent ? h('p', { class: 'sent', role: 'status' }, sent) : null,
      failed ? h('p', { class: 'error', role: 'alert' }, failed) : null);
  }

  function CardItem({ card, ctx }: { card: Row; ctx: Ctx }) {
    const meta = [String(card.risk ?? ''), plainLink(String(card.context ?? '')), ago(card.created, ctx.now)].filter(Boolean).join(' · ');
    return h('li', { class: 'card', 'data-risk': card.risk },
      h('h3', null, String(card.title ?? '')),
      h('p', null, String(card.reason ?? '')),
      h('p', { class: 'muted' }, meta),
      card.result ? h('p', { class: 'result' }, String(card.result)) : null,
      h(CardButtons, { card, ctx }));
  }

  function CardsView({ rows, ctx }: { rows: Row[]; ctx: Ctx }) {
    const pending = rows.filter(r => r.status === 'pending');
    const auto = rows.filter(r => r.decided_by === 'policy' && r.status !== 'pending').slice(0, 5);
    return h('div', null,
      pending.length ? h('ul', { class: 'cards' }, pending.map(c => h(CardItem, { key: String(c.file), card: c, ctx }))) : h('p', { class: 'empty' }, 'Nothing waiting on you.'),
      auto.length ? h('h3', { class: 'sub' }, 'Ran on their own') : null,
      auto.length ? h('ul', { class: 'cards auto' }, auto.map(c => h(CardItem, { key: String(c.file), card: c, ctx }))) : null);
  }

  return { today: TodayView, cards: CardsView };
}
