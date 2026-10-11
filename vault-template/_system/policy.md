---
type: policy
---
# Autonomy policy

Each action type has a trust level:
- **suggest:** the action needs a click.
- **auto-notice:** it runs on its own, with a notice and an Undo button.
- **silent:** it only gets logged.

Promotion to the next level is proposed after N approvals in a row with no rejects or undos, and the promotion itself needs approval. Any reject or undo demotes the action one level.

| action | level | promote after | approvals in a row |
|---|---|---|---|
| triage_inbox | auto-notice | — | 0 |
| update_daily | silent | — | 0 |
| file_note | suggest | 5 | 0 |
| create_widget | suggest | 5 | 0 |
| continue_agent | suggest | 10 | 0 |
| book_event | suggest | 10 | 0 |
| archive_note | suggest | 10 | 0 |

## Hard ceilings (always suggest, never promoted)
- Sending anything to other people.
- Spending money.
- Deleting.
- Touching anything outside the vault and repos.
- Pushing to main.
