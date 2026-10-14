import type { Manifest, Row } from '../types';
import w0_ci_status_manifest from './ci-status/widget.json';
import w0_ci_status_fixture from './ci-status/fixture.json';

export const codeCatalog: Record<string, { manifest: Manifest; fixture: Row[] }> = {
  'ci-status': { manifest: w0_ci_status_manifest as unknown as Manifest, fixture: w0_ci_status_fixture.rows },
};
