import path from 'node:path';

// Windows paths compare case-insensitively; a missing path matches nothing.
export const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
