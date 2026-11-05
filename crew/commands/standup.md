---
description: What is going on across your projects — waiting on you, in progress, open bugs, done this week — read off the Portal board.
argument-hint: "[project]"
---

Call the `portal` MCP `tasks` tool with `project` set to `$ARGUMENTS` (or `"*"`
when empty, for every project) and `done: true`. If it says Portal is not
running, tell the user in one line and stop.

Report, skipping any section that is empty:

1. **Waiting on you** — tasks assigned to `owner`, with what each needs. First,
   because it is the point of the standup.
2. **In progress** — per project: who has it and their last note.
3. **Open bugs** — per project, highest priority first.
4. **Done this week** — one line each.
5. **Queued** — open, unassigned task count per project.

Terse: one line per task, no commentary.

Then, if two or more projects have queued work, offer to put one employee on
each — a separate session per project, started in that project's folder,
running `/crew:work`. In the Claude desktop app, start them as sessions once
the user says yes. Elsewhere, give the user one command per project to run from
its folder:

```bash
claude "/crew:work"
```

Never more than 10 at once.
