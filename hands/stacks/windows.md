# Windows desktop

One window, addressed by name. No monitor to find, nothing to move, nothing to
bring forward: `PrintWindow` asks a window to draw itself into a bitmap, so it
works while the window is covered, on another monitor, off-screen or minimised.

```powershell
powershell -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/win.ps1" list
powershell -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/win.ps1" shot  "My App" out.png
powershell -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/win.ps1" tree  "My App"
powershell -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/win.ps1" click "My App" 420 300
powershell -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/win.ps1" type  "My App" "hello"
powershell -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/win.ps1" key   "My App" RETURN
```

The match is a pid or any part of the title. `list` first: titles change under you
(an editor appends `*` the moment you type into it, and the next match then fails).

## Input is posted, not performed

`click`, `type` and `key` are `PostMessage` into the window's own queue. The mouse
does not move and focus does not change, so the user can keep typing elsewhere while
a flow runs. The cost is that nothing is guaranteed to arrive:

- Win32 controls (Edit, RichEdit, Button, native dialogs) take it reliably.
- Flutter desktop takes posted clicks: a click into a background Flutter window
  moved its counter, with no focus taken (`stacks/flutter.md`). Chromium and
  Electron take keyboard input on the top window and are less predictable on
  clicks, because the hit test happens in the renderer.
- Anything reading raw device state - games, custom input stacks, apps using Raw
  Input or DirectInput - ignores posted messages entirely.

So: post, then `shot` and check. When it did not land, say so and ask before
`win.ps1 focus` (which does take the foreground) or the computer-use MCP.

Coordinates for `click` are client coordinates of the matched window, not screen
coordinates - the point of this script is that where the window sits on the desktop
stops mattering. `tree` prints each child control with its class, text and rect to
pick a point from; for a window with no child controls (Flutter, Electron, a game)
there is nothing to list, so read the point off a `shot`.

## Traps

- **PowerShell 5.1 reads scripts as ANSI.** A non-ASCII character in `win.ps1`
  becomes a stray quote and the whole file fails to parse with a pile of nonsense
  about `<` being reserved. Keep the file ASCII-only.
- **`PrintWindow` returning a blank image** means the window refuses to self-draw -
  rare since `PW_RENDERFULLCONTENT`, but some GPU-composited surfaces (video
  overlays, a few games) still come back black. Fall back to the computer-use MCP.
- **`type` goes to the first Edit/RichEdit child**, not to whatever has the caret.
  On a window with several fields, `click` the field first.
- **A minimised window is restored with `SW_SHOWNOACTIVATE`** for the duration of a
  `shot` and minimised again after - it flickers in the taskbar but never takes
  focus. Input to a minimised window restores it and leaves it restored.
