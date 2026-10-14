import { Component, h, render, type ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { codeRenderers } from './code/renderers';
import type { CodeView, Host, Manifest, Row } from './types';

type Inbound = { manifest: Manifest; rows: Row[]; now: number };

const send = (msg: Record<string, unknown>) => parent.postMessage(msg, '*');
const report = (e: unknown) => send({ type: 'error', name: String((e as Error)?.name ?? 'Error').slice(0, 40), message: String((e as Error)?.message ?? e).slice(0, 150) });

class Boundary extends Component<{ children?: ComponentChildren }, { failed?: boolean }> {
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { report(e); }
  render() { return this.state.failed ? null : this.props.children; }
}

function start() {
  const id = new URLSearchParams(location.search).get('id') ?? '';
  const create = codeRenderers[id];
  const root = document.getElementById('root');
  if (!create || !root) return report(new Error(`no code widget "${id}"`));
  const View: CodeView = create({ h: h as unknown as Host['h'], useState: useState as Host['useState'] });
  addEventListener('message', (e: MessageEvent<Inbound>) => {
    if (e.source !== parent || !e.data || !Array.isArray(e.data.rows)) return;
    const { manifest, rows, now } = e.data;
    try { render(h(Boundary, null, h(View as never, { m: manifest, rows, ctx: { now } })), root); } catch (err) { report(err); }
  });
  new ResizeObserver(() => send({ type: 'height', height: root.scrollHeight })).observe(root);
  send({ type: 'ready' });
}

start();
