# Android

An emulator with no window. `-no-window` means there is nothing on screen to find,
focus or drag between monitors, and everything comes back over adb: the screen as
text, the screen as a PNG, taps, text, keys, logs.

```bash
node "${CLAUDE_PLUGIN_ROOT}/android.js" up            # boot headless, wait for boot_completed
node "${CLAUDE_PLUGIN_ROOT}/android.js" ui            # the screen as labelled points
node "${CLAUDE_PLUGIN_ROOT}/android.js" tap "Sign in" # tap by visible label
node "${CLAUDE_PLUGIN_ROOT}/android.js" text "me@example.com"
node "${CLAUDE_PLUGIN_ROOT}/android.js" key BACK
node "${CLAUDE_PLUGIN_ROOT}/android.js" logs 80 "MyApp:D *:S"
node "${CLAUDE_PLUGIN_ROOT}/android.js" down
```

`up` with no AVD name takes the first one in `~/.android/avd`. Pass a name to pick
another; a wrong name exits with the list rather than booting nothing.

## Reading the screen

`ui` is the cheap read and the one to reach for. Each line is

```
* Network & internet @393,693      # * means clickable
  Airplane mode is on @384,413     # plain text, not a target
```

so `tap "Network"` needs no screenshot and no coordinates. Assertions work off the
same text: tap a toggle, run `ui` again, look for the label that proves it moved.

`shot` is for the visual question only. A phone screenshot is ~1500 tokens against
~150 for the same screen as text.

## Traps

- **`uiautomator dump /sdcard/u.xml` followed by `adb shell cat` fails under Git Bash**,
  which rewrites the leading `/sdcard` into a Windows path. `android.js` streams the
  dump with `exec-out uiautomator dump /dev/tty` instead. Hit this directly and the
  error is a confusing `cat: /c/Program Files/Git/sdcard/u.xml`.
- **A locked AVD answers every dump with a PIN pad.** If `ui` is nothing but digits,
  the device is at the keyguard: `adb shell wm dismiss-keyguard` clears a swipe lock,
  a real PIN does not — ask, or boot a different AVD. `up` dismisses the keyguard
  after boot for this reason.
- **The label in `ui` is the full label.** `tap "Network"` matches `Network &
  internet` by substring, but only after an exact match fails, so a screen with both
  still lands on the right one.
- **Boot takes 60-120s cold.** `up` polls `sys.boot_completed` for three minutes and
  is a no-op against a device already attached, so calling it before a flow is free.
- **Flutter and React Native render one surface.** `ui` sees real nodes on both only
  because their accessibility trees are on by default in debug builds. A release
  build, or a Flutter app with semantics stripped, dumps one big node — drive it by
  coordinates off a `shot`, or turn semantics back on in the debug build.
