import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Preact escapes everything it renders; these APIs bypass that, so they're banned outright.
const RAW_HTML = 'Render with Preact instead; raw HTML bypasses escaping.';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.astro/**', 'out/**'] },
  {
    files: ['dashboard/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]", message: RAW_HTML },
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: RAW_HTML },
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML'], Property[key.name='dangerouslySetInnerHTML']", message: RAW_HTML },
      ],
    },
  },
);
