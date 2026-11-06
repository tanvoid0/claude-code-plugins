# governor

A `PreToolUse` hook that watches what a session is spending and stops it running
away. Zero always-on token cost: hooks live outside the model's context.

It tallies **every token class at its price** off the session transcript, in
output-token equivalents. Output alone is the wrong meter: measured over 563
real local sessions, input outnumbers output **268:1**, so a gate watching
output watches 0.4% of the bill and stays silent through the runaway.

The runaway is not a loop. Every turn re-reads the whole conversation, so cost
per turn tracks context size, and cumulative cost is **quadratic in turn
count** — a session feels cheap for its first fifth and expensive by its last,
with nothing having gone wrong and no single call to blame.

## Gates

| gate | default | effect |
|---|---|---|
| unbounded output | `git log`, `ls -R`, `find`, full `git diff`, `cat` >64KB | **deny**, naming the bounded form |
| repeat read | a `Read` identical to an earlier one, file unchanged since | **deny**: it is already in context |
| images | 8 in one session | warn: send further screenshots to a subagent |
| context | 120k / 200k / 300k per turn | warn: bound output, delegate search, then hand off to a fresh session |
| burn rate | 120k weighted tokens in 5 min | warn: check the approach is converging, replan smaller if not |
| soft | 60% of budget (900k) | warn: prioritise what is left |
| hard | 100% of budget (1.5M) | **deny** tool calls; the model can still talk to you |

## The handoff

A gate that says *stop* without saying *here is what the next session needs* is
why nobody starts a fresh one: the state lives in the transcript, and abandoning
it feels worse than paying for another 300k-token turn. So the last turn of an
expensive session buys the first turn of a cheap one.

At 300k of context, or once the budget is spent, a `Stop` hook fires **once**
and asks for `.claude/handoff.md` — goal, state, files with paths, decisions and
their reasons, next actions, gotchas. The next session starts with
`read .claude/handoff.md` and skips the archaeology. `/governor:handoff` does
the same on demand, at any size.

It cannot loop: `stop_hook_active` is honoured, and the session's state file
records that it has already fired.

## Parked skills

Everything in `~/.claude/skills/` is listed in every session in every project,
at its full frontmatter description. Measured locally: 32 personal skills came
to **~11k tokens per turn**, on repos where an image-generation or branding
skill never fired once.

A hook cannot fix that — hooks add context, they cannot subtract from a system
prompt that is already assembled. The only real lever is where the skill
directory lives. So: park them in `~/.claude/skills-parked/`, and this plugin
hands discovery back for about 2% of the price.

`hooks/skill-index.js` runs at SessionStart and prints one line per parked
skill — name plus nine words — **only where one could plausibly fire**. A
package.json alone does not qualify: that check was caught out by a Flutter
monorepo whose package.json exists to hold `npm run release`. It wants a real
frontend dependency, or loose `.tsx`/`.html`/`.vue` files, and it bails on any
`pubspec.yaml` within one level.

`/governor:skill <name>` then reads that skill's `SKILL.md` and follows it for
the rest of the session. Same behaviour as a listed skill, paid for only when
used.

## Everything else

Repeat reads are denied only when the file has not changed since — the mtime
check is the design, not a nicety. The worst case in the measured transcripts
was a screenshot read 22 times, every one legitimate because a crop script
rewrote it between reads. A naive path-dedupe would have broken that loop.

Subagent spend counts. A child's tokens are logged to its own transcript and
never appear as usage in the parent's, so a fan-out of ten agents used to cost
the parent's tally nothing. The total that comes back on the tool result is
claimed instead, weighted like input — a child's tokens are mostly its own
system prompt being read.

The unbounded-output gate is the only one that saves tokens without costing
anything: a dump is re-read on every remaining turn, so `git log` and
`git log | head -20` differ by one turn's output and a hundred turns' input.
The denial names the bounded form, so the work still happens.

Context is warned on before spend, because it is the cause rather than the
symptom, and because it fires while the session can still be steered somewhere
cheaper. Burn rate is checked before the budget — spending fast is more urgent
than spending a lot. Warnings do not repeat inside 10 minutes.

At the hard gate every tool call is denied, which is the point: it forces a stop
and a replan rather than a quiet overrun. The model keeps its voice, so it can
report what is done and what is left.

Editing the config is the one thing a denied session may still do — otherwise
the gate strands it with no way out. That doubles as the self-extension: the
model can raise `budget` in the *project* config and carry on, up to `ceiling`.
Past the ceiling nothing it can reach will move the line; only you can, in
`~/.claude/governor.json`. So the budget is where a session should stop and
check in, and the ceiling is where it stops for real.

Defaults are drawn from 563 real sessions, weighted: p50 0.6M, p75 1.7M,
p90 2.8M. Replayed against them, the soft warning fires in 41% and the hard
stop in 28% — the top quartile, which is where the money is. Worked examples
from that replay: a 1.06M session that *felt* like it ran away gets its first
context warning 24% in and is never blocked; a genuine 5.2M runaway is warned
at 7% and stopped at 43%.

Raise `budget` if the stop lands on work that routinely needs the room. Lower
it if you would rather check in sooner.

## Config

`~/.claude/governor.json` sets it for every project. Every field is optional.

```json
{
  "enabled": true,
  "weighted": true,
  "budget": 1500000,
  "ceiling": 4000000,
  "softRatio": 0.6,
  "hardRatio": 1.0,
  "burnTokens": 120000,
  "burnMinutes": 5,
  "rewarnMinutes": 10
}
```

`.claude/governor.json` in a project may then adjust **`budget`,
`burnTokens`, `burnMinutes` and `rewarnMinutes`** — and nothing else.

### `weighted`: count what the session actually costs

**On by default since 0.6.0.** Set it to `false` and the gate counts output
tokens only — the right metric for a session where the model is mostly writing,
and the wrong one for every session that is mostly reading, which in practice is
all of them.

The gap is not small. One measured turn from the [benchmark](../BENCHMARK.md):
**168 output tokens against 322,512 cache reads**, costing $0.3562 — of which
the output was $0.0042, or **1.2%**. Across four tool-heavy agent runs, output
tokens accounted for 5% of the bill. A budget watching output alone barely
moves while such a session spends freely.

Every token class is counted at its price relative to output — input ×0.2,
cache write ×0.25, cache read ×0.02, the opus ratios. The budget's unit is
*output-token equivalents*, so it tracks relative cost rather than a count that
ignores where the money actually goes.

Weighted totals run ~7.5× unweighted ones on the same work, which is why the
0.6.0 defaults are ~7× the old ones. That is a change of unit, not a loosening
of the gate: against the same sessions, the old 200k-of-output budget fired on
6%, the new 1.5M-weighted one fires on 28%.

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
