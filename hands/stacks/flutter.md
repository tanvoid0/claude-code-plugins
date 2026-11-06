# Flutter

Two surfaces, both drivable without the desktop, and the same app drives the same
way on each: read the interface as text, act on a label, read it back.

| target | read | drive | note |
|---|---|---|---|
| Android emulator | `android.js ui` | `android.js tap/text/key` | `stacks/android.md` |
| Windows desktop | `win.ps1 shot` + coordinates | `win.ps1 click/type` | `stacks/windows.md` |

## Android: the whole tree is there

Flutter is often described as opaque to `uiautomator` because it paints one surface.
It is not. A debug build publishes a full semantics tree and `android.js ui` reads
a real screen:

```
  Drive Demo @190,215
  Count is 0 @207,396
* Increment @210,546
* Reset counter @126,714
* Your name @540,892
  Hello Benson @175,1034
```

Tapping `Increment` twice and reading `Count is 2` back needs no screenshot.

What makes it look opaque is **where Flutter puts the label**. Every node comes
through with `text=""` and the visible string in `content-desc` - including plain
`Text` widgets. A reader that keeps a node only when it has `text`, or when it is
clickable, sees a Flutter screen as one button and nothing else. That was a bug in
`android.js`, not a limit of Flutter; `parse()` now takes `text`, else
`content-desc`, else `hint`.

Two more shapes worth knowing, both covered by `android.js selftest`:

- **An icon button names the wrapper and taps the child.** `Semantics(label: 'Reset
  counter')` around an `IconButton` dumps as a named node with `clickable="false"`
  and an unnamed `clickable="true"` child over the same box. Anything sharing a
  point with something clickable is treated as clickable.
- **A `TextField` has no description, only `hint`** - the `labelText`. It comes
  through as an `EditText`, so `ui` marks it an input: `tap "Your name"` then
  `text "Benson"`.

**`SemanticsBinding.instance.ensureSemantics()` is not needed.** Tried it both ways
on the same app, same build: byte-identical `ui` output. The advice to add it is
worth ignoring unless a specific widget is genuinely missing from a dump.

An icon with no `Semantics` label and no text has nothing to name it and will not
appear - that is an accessibility bug in the app, and the dump is the cheapest place
to notice it.

## Windows desktop: one FLUTTERVIEW

`win.ps1 tree` prints exactly one child, `FLUTTERVIEW`, because Flutter draws its
own widgets. So there is no structure to read: capture, and act on coordinates read
off the capture.

Posted input does land. Clicking `Increment` on a background Flutter window and
capturing again showed `Count is 1`, with the window never focused and the mouse
never moved - better than the hit-and-miss the general note warns about for
custom-rendered windows.

Coordinates passed to `win.ps1 click` are window coordinates - measured from the
top-left of the capture, title bar included. The script works out the client offset
itself.

## Builds

```bash
flutter build apk --debug         # ~2-4 min cold, then install and open
flutter build windows --debug
```

Install and launch, with nothing on screen to click:

```bash
node "${CLAUDE_PLUGIN_ROOT}/android.js" install build/app/outputs/flutter-apk/app-debug.apk
node "${CLAUDE_PLUGIN_ROOT}/android.js" open com.example.<app>/.MainActivity
```

`flutter run` wants a terminal to stay attached to and gives hot reload; a built APK
plus `open` is the better fit for a one-off check, since nothing has to stay running
in the foreground. Reach for `flutter run` when iterating on the UI itself.

Release builds strip the debug banner but keep semantics, so `ui` still reads them.
