# Tauri

A native window with a webview inside it. On Windows that webview is WebView2, so
a Tauri window is Chromium wearing a Win32 frame - and it is driven as a window,
not as a page.

```bash
powershell -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/win.ps1" shot  "Portal Desktop" out.png
powershell -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/win.ps1" click "Portal Desktop" 84 213
powershell -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/win.ps1" type  "Portal Desktop" "portal"
```

Verified end to end against a real Tauri 2 + Svelte app whose window sat at
x = -1912 - a second monitor, off the primary, never focused and never moved.

## Capture works

`PrintWindow(PW_RENDERFULLCONTENT)` renders a WebView2 surface correctly: a full
1296x839 capture of the app came back complete, not the black rectangle that
GPU-composited surfaces sometimes give. Nothing special is needed.

## Input has to go deep enough

A Tauri window nests four levels:

```
Tauri Window              <- the top-level window, what you match on
  WRY_WEBVIEW             <- tauri's wrapper
    Chrome_WidgetWin_0/1  <- chromium's own frame
      Chrome_RenderWidgetHostHWND   <- the only one that acts on posted input
```

A click posted to any of the outer three is **swallowed silently** - no error, no
effect, and the title does not change. Only `Chrome_RenderWidgetHostHWND` acts on
it. `win.ps1` descends to the deepest child at the point for exactly this reason;
the earlier version stopped one level down at `WRY_WEBVIEW` and looked broken.

The same applies to keystrokes. A webview has no `Edit` control, so `type` used to
fall back to the top-level window and vanish; it now posts to the innermost child.
A posted `WM_CHAR` arrives as a real key event, so framework state updates
properly - typing into a Svelte-bound search box filtered the list and raised its
"Clear filters" button, which only happens if the binding fired.

**Click the field before typing.** Keystrokes go to whatever the page has focused,
and the innermost window is the page, not a particular element.

## Reading state without a screenshot

`win.ps1 tree` prints the child windows, and `Chrome_WidgetWin_1` carries the
**document title**:

```
264664  Chrome_WidgetWin_1  Overview - Portal Desktop   -1912,64 1280x800
```

For an app that titles its routes, that one line confirms a navigation for a
fraction of a screenshot. It is the cheapest assertion available on this surface -
there is no accessibility tree to read, so everything else needs pixels.

## Coordinates

Pass **window** coordinates - measured from the top-left of what `shot` captured,
title bar included. `win.ps1` converts to the target child itself and prints what
it used (`clicked 76,182 in Chrome_RenderWidgetHostHWND`), which is also how you
tell a mis-aimed click from an ignored one.

## Detection

`ops.js detect` reports `"stack":"tauri","kind":"native"`, so `/shot` captures the
window rather than opening `devUrl` in a browser pane. Both are legitimate - the
dev server does serve the same UI at `http://localhost:1420`, and the Browser pane
gives a real accessibility tree and console access that the webview does not.

Use the browser pane for frontend work, and the window for anything touching Rust:
IPC commands, the native menu, window state, or the packaged build. Only the window
is the actual application.

Watch for a **stale `.claude/launch.json`**: an entry that runs `pnpm dev` in a
Tauri repo starts the frontend alone and reports `web`, so `/shot` would point a
browser at half the app. `load()` refuses such an entry now, but a hand-written one
with `tauri` in the command is trusted as-is.
