# productivity-os: working agreement for agents

## Tests come first, and every test must earn its place
- Write the test before the code. Run it and watch it fail for the reason you expect, then write the code that makes it pass.
- A test protects a behaviour someone relies on: a guardrail, a privacy line, a state change, a contract with another tool. Don't test lookup tables, one-line helpers already exercised elsewhere, or anything that can't fail.
- Name a test after the behaviour it protects, not after when or why it was written.
- When you add a behaviour that matters, add a line to `tools/quality/mutants.mjs`. `npm run mutants` breaks each one in turn, and every break must turn the suite red.

## Gate
`mise run gate` (lint with habit-hooks, typecheck, tests, audit) must be green before a push. The browser smoke test is `npm --workspace dashboard run build && npm --workspace dashboard run smoke`.
