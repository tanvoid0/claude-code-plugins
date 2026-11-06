---
description: Screenshot the running app — browser pane for web stacks, the window itself for native, adb for Android.
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
- **`"kind": "native"`** — capture the window's own pixels. No focusing, no moving
  it, no hunting for the right monitor:

  ```bash
  powershell -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/win.ps1" list
  powershell -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/win.ps1" shot "<title>" <out.png>
  ```

  Then `Read` the PNG. The app must already be running; `/up` it first if not.
  `win.ps1` is Windows-only — on macOS or Linux fall back to the computer-use MCP.
- **an Android emulator or device** — `node "${CLAUDE_PLUGIN_ROOT}/android.js" shot
  <out.png>`. `ui` first if the question is about text or what is tappable.

`kind` is derived from the command, so it is right for a cached workspace app
too. A `compose` stack reports `web`; check what the compose file publishes if
the cached port looks wrong.

Prefer `read_page` / `get_page_text` for a page, `android.js ui` for a device, and
`win.ps1 tree` for a window over a screenshot when the question is about text or
structure — all three are an order of magnitude cheaper and name the thing to act
on. Screenshot when the question is genuinely visual: layout, spacing, colour, or
"does this look right".

To drive the app rather than just look at it, `/drive`. For a web page, `stacks/web.md`
also has the console and network checks that a screenshot cannot give you.
