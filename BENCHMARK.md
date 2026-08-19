# Benchmark

Measured 19 August 2026. Every figure comes from a transcript or an executed
check — none is estimated. Method and limitations are at the bottom; read them
before quoting anything here.

## crew — four identical tasks, two arms

A 176-line billing service was built as the fixture, with defects that interact
rather than sit in isolation: `applyDiscount` and `taxFor` return fractional
cents, which makes `settle.js`'s `total === inv.paid_cents` fail on 80% of
orders (measured: 4,000 of subtotals 1–5,000).

Each task ran on its own pristine copy of the fixture. Task text was
byte-identical between arms — only the agent differed.

- **Arm A** — `general-purpose` at the session model. What you get with no
  plugin: one strong model for everything.
- **Arm B** — `crew`'s routing: `quick` (haiku), `scout` (sonnet),
  `coder` (sonnet), `reviewer` (opus).

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

Correctness was verified independently rather than taken from the agents'
own reports: both `formatMoney` implementations pass the same 6 cases, both
typo fixes landed on the right line, the read-only tasks left zero files
modified, and every arithmetic claim either reviewer made was re-executed.
Neither arm hallucinated a finding.

### Two results that matter more than the headline

**T4 ran opus on both sides.** `crew` routes review to opus, so no model
changed — and Arm B still cost half as much. That saving is prompt discipline,
not routing. The plugin is doing two separate things and only one of them is
the model table.

**The cheap tier lost something real.** Both arms found all six ground-truth
defects on the settlement path. Arm A then found three more that Arm B did not
report: an empty item list settling a zero invoice, no per-invoice error
isolation, and an unclamped `discount_percent` producing negative money.

That is the honest trade. `crew` answers the question asked, for a third of the
price. The stronger model more often answers the question you should have
asked. On a mixed workload of small tasks that trade is worth making; on a
workload that is all architecture and review it is not, because those already
route to the top model and the saving collapses toward zero.

## governor — replayed over 395 real sessions

Not a simulation. The gate's own logic was run over every session transcript on
one machine — 1 GB of JSONL, 27.7M output tokens — using its own rules: output
tokens only, deduplicated by message id.

| measure | value | meaning |
|---|---|---|
| sessions analysed | 395 | every transcript with recorded output |
| total output tokens | 27,654,732 | priced per turn at that turn's own model |
| total output spend | $690.13 | output only; input and cache excluded |
| median session | 45,292 | a normal session is nowhere near the gate |
| p90 / p99 | 162,517 / 320,738 | the tail is where the money is |
| largest session | 432,460 | $10.81, of which $5.77 landed after 200k |
| burn-rate warnings | 84 (21%) | 25k output tokens inside 5 minutes |
| soft warnings | 74 (19%) | crossed 60% of budget |
| **hard stops** | **24 (6.1%)** | would have been denied at 200k |
| past the ceiling | 2 | beyond 350k — only the user could lift these |
| **spend past the gate** | **$40.34** | 5.8% of all output spend |

This reproduces the figures in [governor's README](governor/README.md) from raw
data: it claims ~390 sessions, median 45k, p90 163k, p99 321k, and a 200k budget
interrupting "the top ~6%". Replaying from scratch gives 395, 45,292, 162,517,
320,738, and 6.1%.

### Read $40.34 as a ceiling, not a saving

It is the spend that occurred *after* the point `governor` would have denied the
next tool call. It is not money the plugin would have banked: some of that work
was useful and finished the job, and the gate is deliberately liftable — a
session that genuinely needs more can raise `budget` up to the ceiling.

The defensible claim is narrower and better: **in 24 sessions, $40.34 of spend
happened silently that would instead have become an explicit decision.**

`governor` is not a cost-reduction tool and should not be sold as one. It is
insurance on the tail. 94% of the time it does nothing at all.

## Does the routing actually happen?

The table above hand-picked the agent for each task, so it measured the routing
*table*, not whether routing occurs. That is the load-bearing assumption, so it
was tested separately.

**Blind dispatch.** A dispatcher was given the six published agent descriptions
and 18 realistic tasks — three per tier — with no other context and no access to
the repository, and asked to pick one agent per task.

| result | value |
|---|---|
| correct routes | **18 / 18** |
| tool calls used | 0 |
| time | 8.7s |

The descriptions disambiguate on their own. This matters more than the cost
table: routing that misfires to the expensive tier a third of the time would
erase most of the 68% saving, and a description that reads well to a human but
not to a dispatcher is the usual way that happens.

**Hand-back.** `crew` claims an agent handed work below its tier names the
right agent instead of attempting it. Three probes against `crew:quick`
(haiku):

| probe | expected | result | tokens |
|---|---|---|---|
| architecture decision + migration plan | hand back | refused, named `crew:planner` | 8,897 |
| "somewhere in here there is retry logic, find it" | hand back to `scout` | **did not hand back** — searched (13 tool calls) and answered | 16,483 |
| change `PAGE_SIZE` to 50 *(in-tier control)* | do it | done correctly, `orders.js:5` | 12,059 |

**One of the two out-of-tier probes failed.** `quick`'s description says it
refuses "any task that starts with finding out where something lives", and the
retry-logic probe was exactly that. It searched anyway. The answer it gave was
correct, and at 16k haiku tokens it was still far cheaper than the alternative —
but the guarantee is softer than the description implies. A refusal is a
behavioural instruction to a model, not a mechanism, and it does not hold every
time.

Where it does hold, it is the cheapest possible correction: ~9k haiku tokens to
bounce a mis-route, against 137k opus tokens for a comparable task at the
default tier. The control probe confirms it does not simply refuse everything.

## Known gap: subagent spend is invisible to governor

`governor` tallies the session transcript that the hook is handed. Subagent
turns are not written there — they go to a separate file per agent,
`<session>/subagents/agent-*.jsonl`, and never appear as sidechain entries in
the session transcript the hook reads.

So a session that fans work out to subagents can burn a large amount that the
gate never sees. The benchmark runs on this page spent roughly 1.2M tokens
between them, none of which was visible to the budget.

This is a real limitation rather than a tuning question, and it is worth knowing
before relying on the budget in a subagent-heavy workflow.

## Method

Costs are computed from each agent's own transcript, deduplicated by message id
— streaming logs the same assistant message more than once, which would
otherwise double every number — then split into input, output, cache-write and
cache-read and priced at published rates: opus $5/$25, sonnet $3/$15, haiku
$1/$5 per MTok, cache write 1.25× input, cache read 0.1× input.

The whole experiment cost $1.68.

## What would change these numbers

- **n = 1 per cell.** Eight agent runs, no repeats. The T1 gap (33×) is far too
  large to be noise; the 2× gaps on T2–T4 could move on a rerun.
- **Two variables move at once.** A `crew` agent differs from the baseline in
  both model and system prompt. T4 isolates the prompt effect at roughly half;
  the other tasks do not separate them. This measures the plugin as shipped,
  which is what a user experiences, but it is not a clean model-only comparison.
- **Small fixture.** 176 lines. Real repositories carry far more context, which
  changes cache economics — the baseline arm read 322,512 cached tokens on T4
  alone.
- **Sonnet intro pricing ignored.** Priced at the standard $3/$15. Sonnet 5 is
  $2/$10 promotionally until 31 August 2026, which would make `crew` look
  *better* than shown.
- **One developer's sessions.** The 395 transcripts are a single person's
  distribution across 25 projects. Someone running long agentic sweeps daily
  would hit the gate far more often than 6% of the time.
- **Task selection.** Four tasks chosen to span `crew`'s tiers.
