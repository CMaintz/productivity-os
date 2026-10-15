import { h, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { connect, type Source } from '../lib/data';
import { CodeFrame } from './CodeFrame';
import type { Snapshot } from '../lib/types';
import { createViews, type Ctx, type Host, type Press, type Row } from '../widgets';

const { Board } = createViews({ h: h as unknown as Host['h'], useState: useState as Host['useState'], CodeFrame });
const STALE_MS = 10 * 60_000;

function pressFor(source: Source): Ctx['press'] {
  return async (card: Row, p: Press, reason: string) => {
    await source.press({ card_file: String(card.file), card_key: String(card.key), ...p, reason: reason.trim() || undefined });
    return source.demo ? 'Demo mode: nothing was sent.' : 'Sent. Your PC applies it within a minute.';
  };
}

function reportOncePerWidget(source: Source): Ctx['reportError'] {
  const sent = new Set<string>();
  return (id, message) => {
    if (sent.has(id)) return;
    sent.add(id);
    void source.reportError(id, message).catch(() => {});
  };
}

function Header({ source, login }: { source: Source; login: string | null }) {
  return (
    <header class="top">
      <a class="logo" href="/">CM<span>dash</span></a>
      <div class="user">
        {source.demo && <span class="tag">demo</span>}
        {login && <span>{login}</span>}
        {login && !source.demo && <button class="quiet" onClick={() => source.signOut().then(() => location.reload())}>Sign out</button>}
      </div>
    </header>
  );
}

function SignIn({ source }: { source: Source }) {
  return (
    <section class="panel signin">
      <h2>Sign in</h2>
      <p>This dashboard is private. Sign in with the GitHub account that owns it.</p>
      <button class="primary" onClick={() => source.signIn()}>Sign in with GitHub</button>
    </section>
  );
}

function Body({ source, snap }: { source: Source; snap: Snapshot }) {
  const now = Date.now();
  const stale = now - new Date(snap.generatedAt).valueOf() > STALE_MS;
  const [reportError] = useState(() => reportOncePerWidget(source));
  const ctx: Ctx = { now, demo: source.demo, press: pressFor(source), reportError };
  return (
    <>
      {stale && <p class="banner" role="status">No update from {snap.host} for a while. Is the PC on and the executor running?</p>}
      {Board({ layout: snap.layout, widgets: snap.widgets, ctx }) as VNode}
      <p class="footer muted">Snapshot from {snap.host}</p>
    </>
  );
}

function useSnapshot(source: Source, signedIn: boolean) {
  const [snap, setSnap] = useState<Snapshot | null | undefined>(undefined);
  const [error, setError] = useState('');
  const latest = useRef(0);
  useEffect(() => {
    if (!signedIn) return;
    const load = () => {
      const n = ++latest.current;
      return source.snapshot().then(
        s => { if (n === latest.current) { setError(''); setSnap(s); } },
        (e: Error) => { if (n === latest.current) setError(e.message); });
    };
    void load();
    return source.watch(load);
  }, [signedIn]);
  return { snap, error };
}

export default function Dashboard() {
  const [source] = useState(() => connect());
  const [login, setLogin] = useState<string | null | undefined>(undefined);
  useEffect(() => { void source.user().then(u => setLogin(u?.login ?? null)); }, []);
  const { snap, error } = useSnapshot(source, !!login);
  let main;
  if (login === null) main = <SignIn source={source} />;
  else if (error) main = <section class="panel"><h2>Couldn't load</h2><p>{error}</p></section>;
  else if (snap === null) main = <section class="panel"><h2>No snapshot yet</h2><p>The main PC hasn't published anything. Check that the executor is running and <code>~/.productivity-os/dashboard.json</code> exists (setup guide step 8).</p></section>;
  else if (snap) main = <Body source={source} snap={snap} />;
  else main = <p class="empty">Loading…</p>;
  return (
    <>
      <Header source={source} login={login ?? null} />
      <main id="main" aria-live="polite">{main}</main>
    </>
  );
}
