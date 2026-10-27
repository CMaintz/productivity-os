// A forge at the end of its build, and verify rounds finished with chosen reports: for the verify
// and demo tests.
import fs from 'node:fs';
import path from 'node:path';
import { listForges } from '../forge.mjs';

export const SPEC =
  '# Spec\n## Problem\nx\n## User stories\n1. As a user, I want a list.\nAcceptance criteria:\n- [ ] saves\n2. As a user, I want to share it.\nAcceptance criteria:\n- [ ] link\n## Non-goals\nx\n';
export const report = (checks, findings = []) => 'Done.\n```json\n' + JSON.stringify({ checks, findings }) + '\n```\n';
export const ok = name => ({ name, ok: true, details: 'fine' });
const QA_CLEAN = report([ok('story 1'), ok('story 2'), ok('axe'), ok('lighthouse'), ok('npm audit'), ok('licenses')]);
const TAGGED = "test('story 1: list', ...);\ntest('story 2: share', ...);\n";

export function verifyFakes({ building, pass, cardBy, press }) {
  const forge = w => listForges(w.v)[0];

  /** A forge whose build just finished and whose "built" card you approved. */
  async function readyToVerify() {
    const w = building({ spec: SPEC });
    for (const n of [11, 12, 13]) w.gh.issues.get(n).state = 'CLOSED';
    await pass(w, 1);
    press(cardBy(w, 'forge_review'), 'done');
    return w;
  }

  /** Finishes the three runs of the current round; qa leaves an E2E file tagged with the stories it covers. */
  function finishRound(w, { qa = QA_CLEAN, arch = report([]), spec = report([]), tests = TAGGED, extra = {} } = {}) {
    const qaRun = [...w.sys.started].reverse().find(r => /^You are the qa/.test(r.prompt));
    fs.mkdirSync(path.join(qaRun.cwd, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(qaRun.cwd, 'e2e', 'stories.spec.ts'), tests);
    w.sys.finish(qa, false, /^You are the qa/, extra);
    w.sys.finish(arch, false, /^You are the architecture/, extra);
    w.sys.finish(spec, false, /^You are the spec/, extra);
  }

  return { SPEC, report, ok, forge, readyToVerify, finishRound };
}
