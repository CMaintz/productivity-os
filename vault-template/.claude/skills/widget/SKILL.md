---
name: widget
description: Propose a new dashboard widget (a declarative JSON manifest) as an action card. Use for "/widget <what you want to see>", "add a widget for...", "show me X on the dashboard", or when /suggest finds the user repeatedly looking something up by hand.
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
