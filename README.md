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
| hard | 100% of budget (120k) | **deny** tool calls; the model can still talk to you |

Burn rate is checked first — spending fast is more urgent than spending a lot.
Warnings do not repeat inside 10 minutes.

At the hard gate every tool call is denied, which is the point: it forces a stop
and a replan rather than a quiet overrun. The model keeps its voice, so it can
report what is done and what is left.

## Config

`.claude/governor.json` in the project, or `~/.claude/governor.json` for all of
them. Project wins. Every field is optional.

```json
{
  "enabled": true,
  "budget": 120000,
  "softRatio": 0.6,
  "hardRatio": 1.0,
  "burnTokens": 25000,
  "burnMinutes": 5,
  "rewarnMinutes": 10
}
```

Raising `budget` mid-session takes effect on the next tool call — no restart.
Off switches: `"enabled": false`, or `GOVERNOR_OFF=1` in the environment.

## Install

## Skills

Two on-demand skills, ~126 tokens always-on between them.

- **`plugin-audit`** — what every installed plugin costs in always-on context,
  sorted, with the `disable` commands. Shells out to `claude plugin list` and
  `claude plugin details`.
- **`find-plugin`** — searches the awesomeclaudeplugins.com catalog (~33k repos)
  and prints install commands. It never installs: a plugin's hooks run on this
  machine at every session start, so that stays a human decision.

## Install

```bash
claude plugin marketplace add D:/production/ai/plugins/governor
```

```bash
claude plugin install governor@governor
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
State lives in `%TEMP%/claude-governor/<session_id>.json` and is read
incrementally, so a long transcript is parsed once, not once per call.
