---
description: Stop this project's dev server, or whatever is holding a given port.
argument-hint: "[port|--all]"
---

Run, passing the user's arguments straight through — a port, `--all`, or
`--force`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/ops.js" down $ARGUMENTS
```

With no port it uses the one cached in the repo root's `.claude/launch.json` —
the entry for the current directory if there is one, otherwise the first.

`--all` kills every port cached for the workspace, which is the only way to
clear a monorepo whose apps were started one at a time. It only knows about apps
that have been detected at least once; `/procs` is the check for anything else.

This kills the listening process and its children — that is deliberate, and it is
what clears a Tauri run, where cargo holds the webview as a child and killing the
listener alone leaves it running.

Report exactly what it printed. It refuses privileged ports (below 1024) unless
`--force` is added; if that happens, tell the user rather than adding the flag.

Then, if a background shell from `/up` is still tracked in this session, stop it
too so the harness is not left watching a dead process.
