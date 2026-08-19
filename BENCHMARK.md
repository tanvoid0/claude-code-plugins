# Benchmark

Measured 19 August 2026. Every figure comes from a transcript or an executed
check. Limitations are at the bottom — read them before quoting anything.

## crew — four identical tasks, two arms

Fixture: a 176-line billing service whose defects interact. `applyDiscount` and
`taxFor` return fractional cents, so `settle.js`'s `total === inv.paid_cents`
fails on 80% of orders (measured: 4,000 of subtotals 1–5,000).

Each task ran on its own pristine copy. Task text was byte-identical between
arms; only the agent differed. **Arm A** is `general-purpose` at the session
model — what you get with no plugin. **Arm B** is `crew`'s routing.

| task | arm | model | tokens | cost | outcome |
|---|---|---|---|---|---|
| T1 fix a typo | A | opus | 137,469 | $0.3597 | correct |
| T1 fix a typo | B | haiku | 32,692 | **$0.0108** | correct |
| T2 locate money code | A | opus | 139,713 | $0.2187 | correct |
| T2 locate money code | B | sonnet | 75,963 | **$0.1029** | correct |
| T3 implement `formatMoney` | A | opus | 290,918 | $0.3447 | 6/6 cases |
| T3 implement `formatMoney` | B | sonnet | 98,573 | **$0.1173** | 6/6 cases |
| T4 review settlement | A | opus | 353,197 | $0.3562 | 6/6 core + 3 extra |
| T4 review settlement | B | opus | 91,387 | **$0.1740** | 6/6 core |
| **total** | **A** | | **921,297** | **$1.2792** | |
| **total** | **B** | | **298,615** | **$0.4049** | **−68.3%** |

Correctness was verified independently, not taken from the agents' reports: both
`formatMoney` implementations pass the same 6 cases, both typo fixes landed on
the right line, read-only tasks left zero files modified, and every arithmetic
claim was re-executed. Neither arm hallucinated a finding.

**T4 ran opus on both sides** — `crew` routes review to opus, so no model
changed, and Arm B still cost half. That saving is prompt discipline, not
routing. The plugin does two things and only one is the model table.

**The cheap tier lost something real.** Both arms found all six ground-truth
defects. Arm A found three more Arm B did not report: an empty item list
settling a zero invoice, no per-invoice error isolation, and an unclamped
`discount_percent` producing negative money.

So: `crew` answers the question asked, for a third of the price. The stronger
model more often answers the question you should have asked. Worth it on a
mixed workload of small tasks; worth nothing on a workload that is all
architecture and review, which already routes to the top model.

## Does the routing actually happen?

The table above hand-picked each agent, so it measured the routing *table*, not
the routing. Tested separately: a dispatcher got only the six published
descriptions and 18 tasks (three per tier), no repo access.

| descriptions | chars | routes correct |
|---|---|---|
| original | 1,434 | **18 / 18** |
| compressed | 985 (−31%) | **18 / 18** |

Zero tool calls, under 9s. The descriptions disambiguate on their own, and 31%
of them was connective prose — they now cost ~274 always-on tokens instead of
~398, with routing unchanged. This matters more than the cost table: misrouting
a third of the time to the expensive tier would erase most of the 68%.

**Hand-back is softer than advertised.** Three probes against `crew:quick`:

| probe | expected | result | tokens |
|---|---|---|---|
| architecture decision + migration plan | hand back | refused, named `crew:planner` | 8,897 |
| "somewhere in here is retry logic, find it" | hand back to `scout` | **did not** — searched, 13 tool calls | 16,483 |
| change `PAGE_SIZE` to 50 *(control)* | do it | done, `orders.js:5` | 12,059 |

One of two out-of-tier probes failed. `quick`'s description says it refuses "any
task that starts with finding out where something lives"; it searched anyway.
The answer was correct and still cheap, but a refusal is an instruction to a
model, not a mechanism. Where it holds it is the cheapest correction available —
~9k haiku tokens to bounce a mis-route against 137k opus tokens to do it at the
default tier. The control confirms it does not simply refuse everything.

## governor — replayed over 395 real sessions

Not a simulation. The gate's own logic run over every session transcript on one
machine — 1 GB of JSONL, 27.7M output tokens — using its own rules: output
tokens only, deduplicated by message id.

| measure | value |
|---|---|
| sessions analysed | 395 |
| total output tokens / spend | 27,654,732 / $690.13 |
| median | 45,292 |
| p90 / p99 | 162,517 / 320,738 |
| largest session | 432,460 ($10.81, $5.77 of it past 200k) |
| burn-rate warnings | 84 (21%) |
| soft warnings | 74 (19%) |
| **hard stops** | **24 (6.1%)** |
| past the ceiling | 2 |
| **spend past the gate** | **$40.34** (5.8% of all output spend) |

This reproduces [governor's README](governor/README.md) from raw data. It claims
~390 sessions, median 45k, p90 163k, p99 321k, and a 200k budget interrupting
"the top ~6%"; replaying from scratch gives 395, 45,292, 162,517, 320,738, 6.1%.

**Read $40.34 as a ceiling, not a saving.** It is spend that occurred *after* the
gate would have denied the next call. Some of that work was useful, and the gate
is deliberately liftable. The defensible claim is narrower: in 24 sessions,
$40.34 happened silently that would instead have been an explicit decision.
`governor` is insurance on the tail, not a cost-reduction tool — 94% of the time
it does nothing.

## Two gaps this found

**Subagent spend is invisible.** The hook tallies the session transcript.
Subagent turns go to `<session>/subagents/agent-*.jsonl` and never appear there
as sidechain entries. The eight runs above spent ~1.2M tokens the budget never
saw. A real limitation, not a tuning question.

**Output tokens were 5% of what these runs cost.** Arm A's T4: 168 output tokens
against 322,512 cache reads and 30,503 cache writes → $0.3562, of which output
was $0.0042 — **1.2%**. Across all four Arm A tasks output was 5.4% of spend;
Arm B, 10.5%. The README's rationale is that output tokens drive cost. That
holds for a session that writes and fails for one that reads, because cache
reads at 0.1× input still dominate when there are three orders of magnitude more
of them. Addressed in 0.5.0 by [`"weighted": true`](governor/README.md), off by
default.

## Method

Costs come from each agent's own transcript, deduplicated by message id —
streaming logs the same assistant message twice, which would double every number
— split into input, output, cache-write and cache-read, priced at published
rates: opus $5/$25, sonnet $3/$15, haiku $1/$5 per MTok; cache write 1.25×
input, cache read 0.1×. The whole experiment cost $1.68.

## What would change these numbers

- **n = 1 per cell.** Eight runs, no repeats. The T1 gap (33×) is far too large
  to be noise; the 2× gaps on T2–T4 could move on a rerun.
- **Two variables move at once.** A `crew` agent differs in both model and
  prompt. T4 isolates the prompt effect at roughly half; the others do not
  separate them. Measured as shipped, which is what a user experiences.
- **Small fixture.** 176 lines. Real repositories carry more context, which
  changes cache economics — Arm A read 322,512 cached tokens on T4 alone.
- **Sonnet intro pricing ignored.** Priced at standard $3/$15; Sonnet 5 is
  $2/$10 until 31 August 2026, which would make `crew` look *better*.
- **One developer's sessions.** 395 transcripts, one person, 25 projects. Anyone
  running long agentic sweeps daily would hit the gate more than 6% of the time.
- **Task selection.** Four tasks chosen to span `crew`'s tiers.
- **Routing tasks were unambiguous by construction.** 18/18 says the
  descriptions separate cleanly on clear cases, not that real prompts are clear.
