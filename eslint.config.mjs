import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.astro/**', 'out/**'] },
  { files: ['dashboard/src/**/*.ts'], extends: [js.configs.recommended, ...tseslint.configs.recommended] },
);
