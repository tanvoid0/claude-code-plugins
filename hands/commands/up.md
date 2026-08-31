---
description: Start this project's dev server in the background and wait until its port actually answers.
argument-hint: "[app] [--fresh]"
---

Run, passing the user's arguments straight through — a workspace app name, and
`--fresh` to ignore the cache and re-detect:

```bash
node "${CLAUDE_PLUGIN_ROOT}/ops.js" detect $ARGUMENTS
```

If `${CLAUDE_PLUGIN_ROOT}` does not expand, the script is at
`~/.claude/plugins/cache/tanvoid0/hands/*/ops.js` (take the highest version).

It prints `{stack, kind, command, port, url, cwd}` and caches the answer in the repo root's
`.claude/launch.json`, so the next session skips detection entirely.
`"cached": true` means it came from that file rather than a fresh scan. If the
cached command looks wrong for the repo, rerun with `--fresh`.

The port is not always the stack default: a `--port`/`-p` flag in the dev
script wins, then the framework's own config, then `PORT` in an env file.

**Exit 2 means ambiguous** — a monorepo whose root is not itself runnable. The
output lists the apps it found. Do not pick one silently: show the list and ask
which, then rerun with that name (`/up apps/web`).

Exit 1 means nothing was recognised. Do not guess a command. Say so, and offer
to write `.claude/launch.json` by hand once the user names the start command.

Otherwise start it — **with `run_in_background: true`**, from the printed `cwd`
— using the printed `command`. Do not wait for it to exit; a dev server does
not exit.

Then, if a `port` was printed, confirm it is really up:

```bash
node "${CLAUDE_PLUGIN_ROOT}/ops.js" wait <port>
```

Spawning is not starting — a dev server that dies on a syntax error still
spawns. If `wait` fails, read the background shell's output and report the
actual error rather than saying it started.

If something is already listening on the port before you start, do not start a
second one: say what is there and offer `/restart`.
