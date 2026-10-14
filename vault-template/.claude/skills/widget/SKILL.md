---
name: widget
description: Propose a new dashboard widget as an action card - a declarative JSON manifest, or a coded widget an agent builds when a manifest can't express it. Use for "/widget <what you want to see>", "add a widget for...", "show me X on the dashboard", or when /suggest finds the user repeatedly looking something up by hand.
---

# /widget <what to show>

Follow `CLAUDE.md` ("Widgets" and "Action cards"). Don't write files in `_system/widgets/` yourself. Propose through the CLI so the card, trust ladder and Undo all work.

1. **Pick a source:**
   - `{"kind":"snapshot","collection":"projects"|"cards"|"sessions"|"today"}` for what the system already tracks.
   - `{"kind":"notes","folder":"<vault folder>"}` for any folder of notes. You must list `fields`, which are frontmatter keys only. Note bodies never leave the PC, and fields like `last_prompt` are refused.
2. **Pick a view:**
   - `stat`: a count, or the sum of `valueField`.
   - `list`: titles plus `fields`.
   - `table`: one column per field.
   - `kanban`: needs `groupBy`.
   - `bar`: needs `groupBy` (counts) or `valueField`.
3. **Narrow it:**
   - `where`: `{ field: value }`, or `{ field: { "ne"|"gt"|"lt"|"in"|"contains"|"exists": x } }`, or `{"$or":[…]}`.
   - `sort`: `[{ "field", "dir": "asc"|"desc" }]`.
   - `limit`: up to 200.
   - `size`: `s`, `m`, `l` or `full`.
4. **Check that the fields exist.** Look at a couple of real notes in the folder. A widget over fields nobody fills in is noise.
5. **Propose:**
   ```
   node <productivityOs>/tools/widgets/widgets.mjs create '{"id":"…","title":"…","view":"…","size":"m","fields":[…],"source":{…},"reason":"why the user wants this, with evidence"}'
   ```
   Fix any validation errors it prints. Then tell the user the card is waiting on Home and the dashboard. Approving it adds the widget, and Undo removes it.

## When a manifest isn't enough: a code widget
Propose a **code widget** only when the views above can't do it: a custom layout or interaction, or a computed view that `where`/`sort` can't express. Examples: a CI traffic light per project, or a timeline. An agent builds it through a ticket and PR, so it costs usage. Prefer a manifest whenever one works.

```
node <productivityOs>/tools/widgets/code-widgets.mjs propose '{"id":"…","title":"…","purpose":"what it shows and why the user wants it","source":{…},"fields":[…]}'
```
- Same `source` and `fields` rules as above. Code widgets can't read `today`, and they get exactly the fields listed (plus title, path and slug).
- `purpose` becomes the ticket's intent, so be specific about what the view looks like.
- Approving the card opens the ticket. When the PR merges, the widget shows up on its own with an Undo card.
