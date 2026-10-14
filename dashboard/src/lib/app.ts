import { connect, type Source } from './data';
import { renderDashboard } from './render';
import type { CardPress } from './types';

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const main = () => $<HTMLElement>('#main');

function setUser(source: Source, login: string | null) {
  const el = $<HTMLElement>('#user');
  const mode = source.demo ? '<span class="tag">demo</span> ' : '';
  el.innerHTML = login ? `${mode}<span>${login.replace(/[<>&"]/g, '')}</span>${source.demo ? '' : ' <button id="signout" class="quiet">Sign out</button>'}` : '';
  document.getElementById('signout')?.addEventListener('click', () => source.signOut().then(() => location.reload()));
}

function signInScreen(source: Source) {
  main().innerHTML = '<section class="panel signin"><h2>Sign in</h2><p>This dashboard is private. Sign in with the GitHub account that owns it.</p><button id="signin" class="primary">Sign in with GitHub</button></section>';
  $<HTMLButtonElement>('#signin').addEventListener('click', () => source.signIn());
}

async function refresh(source: Source) {
  try {
    const snap = await source.snapshot();
    main().innerHTML = snap
      ? renderDashboard(snap)
      : '<section class="panel"><h2>No snapshot yet</h2><p>The main PC hasn\'t published anything. Check that the executor is running and <code>~/.productivity-os/dashboard.json</code> exists (setup guide step 8).</p></section>';
  } catch (e) {
    main().innerHTML = `<section class="panel"><h2>Couldn't load</h2><p>${String((e as Error).message).replace(/[<>&]/g, '')}</p></section>`;
  }
}

function pressFrom(button: HTMLButtonElement): CardPress {
  const [status, flag] = (button.dataset.press ?? '').split(':') as [CardPress['status'], string | undefined];
  const file = button.dataset.file ?? '';
  const reason = document.querySelector<HTMLInputElement>(`input.reason[data-file="${CSS.escape(file)}"]`)?.value.trim();
  return { card_file: file, card_key: button.dataset.key ?? '', status, always: flag === 'always', never: flag === 'never', reason: reason || undefined };
}

async function onPress(source: Source, button: HTMLButtonElement) {
  const card = button.closest('.card') as HTMLElement;
  const note = card.querySelector('.sent') as HTMLElement;
  card.querySelectorAll('button, input').forEach(el => ((el as HTMLButtonElement).disabled = true));
  try {
    await source.press(pressFrom(button));
    note.textContent = source.demo ? `Demo mode: "${button.textContent}" would be sent to your PC.` : `Sent "${button.textContent}". Your PC applies it within a minute.`;
    card.classList.add('is-sent');
  } catch (e) {
    note.textContent = `Couldn't send: ${(e as Error).message}`;
    card.querySelectorAll('button, input').forEach(el => ((el as HTMLButtonElement).disabled = false));
  }
  note.hidden = false;
}

export async function start() {
  const source = connect();
  const user = await source.user();
  setUser(source, user?.login ?? null);
  if (!user) return signInScreen(source);
  await refresh(source);
  source.watch(() => refresh(source));
  main().addEventListener('click', e => {
    const button = (e.target as Element).closest<HTMLButtonElement>('button[data-press]');
    if (button) void onPress(source, button);
  });
}
