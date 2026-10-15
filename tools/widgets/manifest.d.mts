export const VIEWS: string[];
export const SIZES: string[];
export const COLLECTIONS: string[];
export const CODE_COLLECTIONS: string[];
export const CODE_VIEW: RegExp;
export const PRIVATE_FIELDS: string[];
export const ID_PATTERN: RegExp;
export function fieldsUsed(m: unknown): string[];
export function validateManifest(m: unknown, opts?: { codeIds?: string[] }): string[];
