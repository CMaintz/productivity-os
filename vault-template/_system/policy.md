---
type: policy
---
# Autonomy policy

Each action type has a trust level:
- **suggest:** the action needs a click.
- **auto-notice:** it runs on its own, shows up as done, and has an Undo button.
- **silent:** it only gets logged.

After *promote after* approvals in a row, a card proposes the next level (up to *max*). The promotion itself needs your approval. Any reject or undo drops the type one level and resets the streak. You can edit this table by hand; the executor rewrites it after each decision.

| action | level | max | promote after | approvals in a row |
|---|---|---|---|---|
| triage_inbox | auto-notice | silent | 5 | 0 |
| pause_stale_project | suggest | auto-notice | 5 | 0 |
| fix_ci | suggest | auto-notice | 10 | 0 |
| reminder | suggest | suggest | — | 0 |
| claude_task | suggest | suggest | — | 0 |
| promote_policy | suggest | suggest | — | 0 |

## Never suggest
Cards whose action type or key is listed here are never created.
- (none yet)

## Hard ceilings (max stays at suggest)
- Sending anything to other people.
- Spending money.
- Deleting.
- Touching anything outside the vault and repos.
- Pushing to main or merging.
