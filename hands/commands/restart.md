---
description: Stop this project's dev server and start it again, confirming the port comes back.
argument-hint: "[app] [--fresh]"
---

The daily loop. Run `/down`, then `/up $ARGUMENTS`, in that order.

Two things that make this more than running both by hand:

- **Wait for the port to clear before starting.** A kill returns before the
  socket is released, and a dev server that finds its port taken will silently
  pick the next one — so the app comes up somewhere you are not looking. After
  `/down`, re-run `ops.js down <port>` once; `nothing listening` is the signal
  it is safe to start.
- **Stop the old background shell.** If a shell from an earlier `/up` is still
  tracked in this session, stop it rather than leaving the harness watching a
  process that is already dead.

Report the port once `ops.js wait` confirms it, not before.
