import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Preact escapes everything it renders; these APIs bypass that, so they're banned outright.
const RAW_HTML = 'Render with Preact instead; raw HTML bypasses escaping.';

// Code widgets (often written by an agent) only render the rows they're handed. The security
// boundary is the sandboxed iframe and its CSP (no network); this rule keeps widgets honest and
// catches mistakes early: no network, storage, DOM globals, timers or dynamic code.
const SANDBOX = 'Code widgets only render the rows they are given; see docs/VAULT.md section 10.';
const SANDBOX_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB',
  'document', 'window', 'globalThis', 'self', 'top', 'parent', 'opener', 'frames', 'navigator', 'location', 'eval', 'Function',
  'importScripts', 'postMessage', 'setTimeout', 'setInterval', 'Image', 'Worker', 'SharedWorker']
  .map(name => ({ name, message: SANDBOX }));

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
  {
    files: ['dashboard/src/widgets/code/**/*.ts'],
    ignores: ['dashboard/src/widgets/code/catalog.ts', 'dashboard/src/widgets/code/renderers.ts'],
    rules: {
      'no-restricted-globals': ['error', ...SANDBOX_GLOBALS],
      'no-restricted-imports': ['error', { patterns: [{ regex: '^(?!\\.\\./\\.\\./(types|format)$|\\./(?!.*\\.\\.))', message: SANDBOX }] }],
      'no-restricted-syntax': ['error',
        { selector: 'ImportExpression', message: SANDBOX },
        { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML|constructor|__proto__|prototype)$/]", message: SANDBOX },
        { selector: "NewExpression[callee.name='Function']", message: SANDBOX },
      ],
    },
  },
);
