# Changelog

## governor

### 0.4.0

**Security.** Three ways out of the gate, closed.

A denied session is allowed to edit the project config — that is the escape
hatch that keeps it from being stranded. But the project config could set *any*
field, so `{"enabled": false}` or `{"hardRatio": 100}` turned the gate off from
inside and the ceiling was decoration.

- The project file may now set `budget`, `burnTokens`, `burnMinutes` and
  `rewarnMinutes`. `enabled`, `ceiling`, `softRatio` and `hardRatio` are
  user-file-only.
- The hard stop is clamped to the ceiling however the numbers are arranged.

**The state file was trusted on the way in.** A `window` that was not an array
threw inside `burnRate` on the next tool call and kept throwing for the rest of
the session — against the promise in the file's own header that it never throws.
Every field is validated now, and `main()` is wrapped, so the guarantee is
structural rather than a property of every line above it.

**State moved out of the shared temp directory.** `os.tmpdir()` →
`~/.claude/governor-state/`. `/tmp` is world-writable on Linux and macOS, so a
predictable path there let any other local user read, poison or symlink the
tally. `session_id` names a file, so it is sanitised. The per-call transcript
read is capped at 8MB, so resuming a session with a very large transcript does
not pull the whole delta into a 5-second hook.

**`find-plugin` treats the catalog as untrusted.** It prints third-party output
into a terminal and into the model's context.

- Repo slugs are allowlisted against GitHub's own rules before being printed
  inside a `claude plugin marketplace add` command a user might paste. Dropped
  entries are reported, not silently swallowed.
- Control characters are stripped from descriptions. `\s` did not cover them,
  and an unescaped `ESC` rewrites the terminal around it.
- `fetch` gets a 10-second timeout. It had none.

**Fixed:** `find-plugin` reported the match count as the catalog size — "catalog
holds 7 plugins" for a query with 7 hits, against a catalog of 88,395. Reads
"Top 3 of 7 matches" now.

### 0.3.0

A ceiling only the user can lift. The budget is where a session should stop and
check in; the ceiling is where it stops for real. Defaults raised to a 200k
budget and a 350k ceiling, drawn from ~390 real sessions (median 45k output
tokens, p90 163k, p99 321k).

### 0.2.x

Token budget and burn-rate gate. `plugin-audit` and `find-plugin` skills.

## crew

### 0.1.0

Six subagents, each pinned to the cheapest model that holds for its job: `quick`
(haiku), `scout` and `coder` (sonnet), `planner` and `reviewer` (opus),
`architect` (fable).
