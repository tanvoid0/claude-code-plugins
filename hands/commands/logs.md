---
description: Show output from the dev server started by /up.
---

If a background shell from `/up` is tracked in this session, read its output
with `TaskOutput` and show the tail — the last ~40 lines, plus every line that
looks like an error or a stack trace regardless of where it sits.

If there is no tracked shell (the server was started in another session, or
before a compact), say so rather than inventing output, and offer either:

- `/procs`, to confirm it is even running, or
- `/restart`, which starts it under a shell this session can read.

Do not re-run the dev command to get logs. That starts a second server on a
taken port, and the second one silently moves to the next port up.
