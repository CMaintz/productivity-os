<!-- What changed and why. Keep it short. -->

## Gate changes

If this PR does any of the following, `ruleset-guard` will block it until you add the
`suppression` label (or `ruleset-change` for a baseline/threshold change) - and the
reason belongs here, not just on the label:

- [ ] Adds an in-source suppression (`eslint-disable`, `@ts-ignore`, `@SuppressWarnings`, `# noqa`, `#pragma warning disable`, a coverage-exclusion) - which rule, and why the exception is safe.
- [ ] Demotes a rule in config (`.editorconfig` `severity`, `tsconfig` `strict`, `csproj` `<NoWarn>`).
- [ ] Deletes, moves, or skips a test - which test, and why coverage is still sound.
- [ ] Grows a ratchet baseline (eslint-suppressions / snooze / arch store).

Delete this section if none apply.
