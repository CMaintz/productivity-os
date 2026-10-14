import { useEffect, useRef, useState } from 'preact/hooks';
import type { Ctx, Row } from '../widgets';
import type { Manifest } from '../widgets/types';

const MAX_HEIGHT = 2000;
type FromFrame = { type?: string; height?: number; name?: string; message?: string };

export function CodeFrame({ m, rows, ctx }: { m: Manifest; rows: Row[]; ctx: Ctx }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const [height, setHeight] = useState(0);
  const [error, setError] = useState('');
  const id = m.view.slice('code:'.length);
  const sendRows = () => frame.current?.contentWindow?.postMessage({ manifest: m, rows, now: ctx.now }, '*');

  useEffect(() => {
    const onMessage = (e: MessageEvent<FromFrame>) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data ?? {};
      if (d.type === 'ready') { ready.current = true; sendRows(); }
      else if (d.type === 'height' && Number.isFinite(d.height)) setHeight(Math.min(Math.max(0, Number(d.height)), MAX_HEIGHT));
      else if (d.type === 'error') {
        const msg = `${String(d.name).slice(0, 40)}: ${String(d.message).slice(0, 150)}`;
        setError(msg);
        ctx.reportError?.(m.id, msg);
      }
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, [m, rows]);
  useEffect(() => { if (ready.current) sendRows(); }, [rows]);

  if (error) return <p class="error">This widget crashed: {error}</p>;
  return <iframe ref={frame} class="code-frame" title={m.title} sandbox="allow-scripts" src={`/widget-frame.html?id=${encodeURIComponent(id)}`} style={{ height: `${height}px` }} />;
}
