---
description: Look at and drive the running app in place — window, emulator or page — without taking over the desktop.
---

Target: **$ARGUMENTS** (empty means this project's app).

Work out which surface the app is on, then read **only that surface's note** from
`${CLAUDE_PLUGIN_ROOT}/stacks/`. The notes exist so this command does not have to
carry every stack in its own text, and so a stack you have never driven can be
added after you work it out once.

| surface | how you know | note to read |
|---|---|---|
| a web page | `ops.js detect` says `"kind": "web"` | `stacks/web.md` |
| a Flutter app | `pubspec.yaml` with a `flutter:` section | `stacks/flutter.md` |
| an Android emulator or device | an `android/` dir, `app/build.gradle`, or `$ARGUMENTS` names one | `stacks/android.md` |
| a window on this machine | anything else with a visible window: desktop app, Tauri shell, emulator UI, game | `stacks/windows.md` |

```bash
node "${CLAUDE_PLUGIN_ROOT}/ops.js" detect
```

Two rules hold on every surface:

1. **Read the interface as text before you screenshot it.** `read_page` for a page,
   `android.js ui` for a device, `win.ps1 tree` for a window. Text is a tenth of the
   tokens and names the coordinates to act on; a screenshot cannot be clicked. Take
   the screenshot when the question is genuinely visual — layout, spacing, colour,
   "does this look right" — or when the text read comes back empty.
2. **Never move the user's windows.** No focusing, no arranging, no switching
   monitors. Every tool here reads a window's own pixels and posts input to it where
   it sits, covered or minimised. `win.ps1 focus` exists only as the last resort when
   posted input is ignored, and asks first.

## When there is no note for this stack

Work it out, drive the app, then **write the note** — `stacks/<stack>.md`, in the
shape of the ones already there: what the surface is, the commands that drive it,
and the traps you actually hit. One short page. Next session reads it instead of
re-deriving it, which is the whole point of the directory.

Add a row to the table above when the new note needs a detection rule of its own.
