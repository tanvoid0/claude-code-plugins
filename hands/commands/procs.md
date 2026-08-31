---
description: List every dev server and container port listening on this machine.
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/ops.js" procs
```

Three columns: port, pid, process. Ports below 1024 are omitted — they are the
operating system, not anything this project started.

A published container port shows as `docker:<container>` rather than the Docker
daemon's pid, which is what every container would otherwise report. If Docker is
not installed or the daemon is down, that lookup is skipped silently.

Report it as a small table. Point out anything that looks like a leftover from
an earlier session — a node, cargo or python process on a port this project uses
— and offer `/down <port>` for it, or `/down --all` if several are stale.

Do not kill anything unasked.
