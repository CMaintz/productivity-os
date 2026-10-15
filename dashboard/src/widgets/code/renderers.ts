import type { CodeWidget } from '../types';
import { createWidget as w0_ci_status } from './ci-status/widget';

export const codeRenderers: Record<string, CodeWidget> = {
  'ci-status': w0_ci_status,
};
