# governor

A `PreToolUse` hook that watches what a session is spending and stops it running
away. Zero always-on token cost: hooks live outside the model's context.

It tallies **output tokens** from the session transcript — they drive cost and
they are what a runaway loop actually burns. Cache reads are ~0.1x and ignored.

## Gates

| gate | default | effect |
|---|---|---|
| burn rate | 25k output tokens in 5 min | warn: check the approach is converging, replan smaller if not |
| soft | 60% of budget | warn: prioritise what is left |
| hard | 100% of budget (200k) | **deny** tool calls; the model can still talk to you |

Burn rate is checked first — spending fast is more urgent than spending a lot.
Warnings do not repeat inside 10 minutes.

At the hard gate every tool call is denied, which is the point: it forces a stop
and a replan rather than a quiet overrun. The model keeps its voice, so it can
report what is done and what is left.

Editing the config is the one thing a denied session may still do — otherwise
the gate strands it with no way out. That doubles as the self-extension: the
model can raise `budget` in the *project* config and carry on, up to `ceiling`.
Past the ceiling nothing it can reach will move the line; only you can, in
`~/.claude/governor.json`. So the budget is where a session should stop and
check in, and the ceiling is where it stops for real.

Defaults are drawn from ~390 real sessions: median spend 45k output tokens,
p90 163k, p99 321k. A 200k budget interrupts the top ~6%; the 350k ceiling is
past all but the very longest.

## Config

`~/.claude/governor.json` sets it for every project. Every field is optional.

```json
{
  "enabled": true,
  "weighted": false,
  "budget": 200000,
  "ceiling": 350000,
  "softRatio": 0.6,
  "hardRatio": 1.0,
  "burnTokens": 25000,
  "burnMinutes": 5,
  "rewarnMinutes": 10
}
```

`.claude/governor.json` in a project may then adjust **`budget`,
`burnTokens`, `burnMinutes` and `rewarnMinutes`** — and nothing else.

### `weighted`: count what the session actually costs

Off by default, the gate counts output tokens only. That is the right metric for
a session where the model is mostly writing, and the wrong one for a session
that is mostly reading.

The gap is not small. One measured turn from the [benchmark](../BENCHMARK.md):
**168 output tokens against 322,512 cache reads**, costing $0.3562 — of which
the output was $0.0042, or **1.2%**. Across four tool-heavy agent runs, output
tokens accounted for 5% of the bill. A budget watching output alone barely
moves while such a session spends freely.

Set `"weighted": true` in the user config and every token class is counted at
its price relative to output — input ×0.2, cache write ×0.25, cache read ×0.02,
the opus ratios. The budget keeps its unit and its meaning: it is now
*output-token equivalents*, and it tracks dollars. Weighted totals run far
higher than unweighted ones on the same work, so raise `budget` when you turn
it on rather than discovering the gate at 20%.

Like `enabled` and `ceiling`, it is user-file-only — a project file switching
the gate back to the metric that undercounts it would be a way out. Changing the
mode restarts that session's tally, because adding weighted numbers to
unweighted ones would produce a figure that means neither.

That split is the whole design, so it is worth being blunt about why. A denied
session is still allowed to edit the project file; that is the escape hatch
that keeps it from being stranded with no way to ask for more. Which means
anything the project file can set, a cornered model can set to let itself out.
So the project file tunes *when the gate speaks*. Whether it stops at all —
`enabled`, `ceiling`, and both ratios — is yours, in the user file. The stop
is clamped to the ceiling however the numbers are arranged.

Raising `budget` mid-session takes effect on the next tool call — no restart.
Off switches: `"enabled": false` in the user file, or `GOVERNOR_OFF=1` in the
environment.

## Skills

Two on-demand skills, ~126 tokens always-on between them.

- **`plugin-audit`** — what every installed plugin costs in always-on context,
  sorted, with the `disable` commands. Shells out to `claude plugin list` and
  `claude plugin details`.
- **`find-plugin`** — searches the awesomeclaudeplugins.com catalog (~88k
  plugins) and prints install commands. It never installs: a plugin's hooks run
  on this machine at every session start, so that stays a human decision. The
  catalog is a third party, so what it returns is treated as untrusted — repo
  slugs are allowlisted before they are printed inside a command you might
  paste, and control characters are stripped from descriptions.

## Install

```bash
claude plugin marketplace add tanvoid0/claude-code-plugins
```

```bash
claude plugin install governor@tanvoid0
```

## Check

```bash
node hooks/governor.js --selftest
```

```bash
node skills/plugin-audit/audit.js --selftest && node skills/find-plugin/find.js --selftest
```

The gate check covers incremental reads, duplicate streaming lines, partial
trailing lines, transcript truncation, window expiry, and each gate firing. The
skill checks cover the CLI output parsers and the result formatter.

## Notes

The hook runs on every tool call, so it costs a node start (~50ms) each time.
It never throws: any failure exits 0 with no output and the tool call proceeds.
State lives in `~/.claude/governor-state/<session_id>.json` and is read
incrementally, so a long transcript is parsed once, not once per call. Home
rather than the temp directory on purpose — `/tmp` is world-writable on Linux
and macOS, and a predictable path there is a predictable path for everyone
else on the machine too.
