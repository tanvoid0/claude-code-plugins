---
description: Screenshot the running app — browser pane for web stacks, desktop capture for native.
---

Get `kind` and `port`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/ops.js" detect
```

- **`"kind": "web"`** — open the printed `url` in the Browser pane
  (`mcp__Claude_Browser__preview_start` with it, or `navigate` if the pane is
  already up) and screenshot from there. Use `url` verbatim rather than building
  one from the port: a dev server on TLS answers on the same port but rejects
  `http://`, and `url` already carries the right scheme.
- **`"kind": "native"`** — use `mcp__computer-use__request_access` for the app,
  then screenshot. The app must already be running; `/up` it first if not.

`kind` is derived from the command, so it is right for a cached workspace app
too. A `compose` stack reports `web`; check what the compose file publishes if
the cached port looks wrong.

Prefer `read_page` or `get_page_text` over a screenshot when the question is
about text or structure — it is cheaper and more accurate. Screenshot when the
question is genuinely visual: layout, spacing, colour, or "does this look right".
