---
type: home
---
# Widgets

Widgets are defined in `_system/widgets/*.json` and laid out for the web dashboard in `_system/layouts/dashboard.json`. The same Preact views render here through **Datacore**, using the shared `_system/widgets/views.md` (generated; don't edit it).

Embed any widget in any note with this block, changing the widget id:

```datacorejsx
const { widgetView } = await dc.require(dc.headerLink("_system/widgets/views.md", "views"));
return await widgetView(dc, "writing");
```

## Needs attention
```datacorejsx
const { widgetView } = await dc.require(dc.headerLink("_system/widgets/views.md", "views"));
return await widgetView(dc, "attention");
```

To get a new widget, ask Claude in the vault: `/widget show my drafts by platform`. It proposes the widget as an action card. Approve it, and it appears on the dashboard (and you can embed it here).
