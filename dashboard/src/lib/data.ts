import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import demo from './demo-snapshot.json';
import { codeWidgets } from '../widgets';
import type { CardPress, Snapshot } from './types';

export interface Source {
  demo: boolean;
  user(): Promise<{ login: string } | null>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  snapshot(): Promise<Snapshot | null>;
  press(p: CardPress): Promise<void>;
  reportError(widgetId: string, message: string): Promise<void>;
  watch(onChange: () => void): () => void;
}

const demoSnapshot = () => ({ ...(demo as unknown as Snapshot), generatedAt: new Date(Date.now() - 60_000).toISOString() });

function codeWidgetFixtureSnapshot(which: string): Snapshot {
  const ids = Object.keys(codeWidgets).filter(id => which === 'all' || id === which);
  const widgets = Object.fromEntries(ids.map(id => [id, { manifest: codeWidgets[id].manifest, rows: codeWidgets[id].fixture }]));
  return { ...demoSnapshot(), layout: ids.map(id => ({ id })), widgets };
}

function demoSource(widget: string | null): Source {
  return {
    demo: true,
    user: async () => ({ login: 'demo' }),
    signIn: async () => {},
    signOut: async () => {},
    snapshot: async () => (widget ? codeWidgetFixtureSnapshot(widget) : demoSnapshot()),
    press: async () => {},
    reportError: async () => {},
    watch: () => () => {},
  };
}

function supabaseSource(client: SupabaseClient): Source {
  return {
    demo: false,
    async user() {
      const { data } = await client.auth.getUser();
      const meta = data.user?.user_metadata ?? {};
      return data.user ? { login: String(meta.user_name ?? meta.preferred_username ?? data.user.email ?? 'you') } : null;
    },
    async signIn() {
      await client.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: window.location.origin } });
    },
    async signOut() {
      await client.auth.signOut();
    },
    async snapshot() {
      const { data, error } = await client.from('snapshot').select('data').maybeSingle();
      if (error) throw error;
      return (data?.data as Snapshot | undefined) ?? null;
    },
    async press(p) {
      const { error } = await client.from('card_events').insert({ ...p, reason: p.reason ?? '' });
      if (error) throw error;
    },
    async reportError(widgetId, message) {
      await client.from('widget_errors').insert({ widget_id: widgetId, message: message.slice(0, 200) });
    },
    watch(onChange) {
      const channel = client.channel('snapshot').on('postgres_changes', { event: '*', schema: 'public', table: 'snapshot' }, onChange).subscribe();
      return () => void client.removeChannel(channel);
    },
  };
}

export function connect(url = import.meta.env.PUBLIC_SUPABASE_URL, key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY): Source {
  const params = new URLSearchParams(window.location.search);
  if (params.has('demo') || !url || !key) return demoSource(params.get('widget'));
  return supabaseSource(createClient(url, key, { auth: { persistSession: true, detectSessionInUrl: true } }));
}
