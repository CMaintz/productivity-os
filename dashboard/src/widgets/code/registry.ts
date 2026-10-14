import type { CodeWidget, Manifest, Row } from '../types';
import { createWidget as w0_ci_status } from './ci-status/widget';
import w0_ci_status_manifest from './ci-status/widget.json';
import w0_ci_status_fixture from './ci-status/fixture.json';

export interface CodeEntry { create: CodeWidget; manifest: Manifest; fixture: Row[] }

export const codeWidgets: Record<string, CodeEntry> = {
  'ci-status': { create: w0_ci_status, manifest: w0_ci_status_manifest as unknown as Manifest, fixture: w0_ci_status_fixture.rows },
};
