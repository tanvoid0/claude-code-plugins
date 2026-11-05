---
description: Work this project's board like an employee — claim the top task, route it through the crew, log progress, close it.
argument-hint: "[task id | new task title]"
---

You are working the board for the project in front of you. The board is
Portal's task list, through the `portal` MCP tools (`tasks`, `task`, `add`,
`update`). Pass the repo root path as `project`. If the tools say Portal is not
running, tell the user in one line and stop.

1. **Pick one task.**
   - `$ARGUMENTS` is a number → that task.
   - `$ARGUMENTS` is text → `add` it (assignee `claude`) and work it.
   - Empty → `tasks`, then take the first open task not assigned to `owner`
     (the list is already sorted: in progress first, then priority). Nothing
     open → say the board is clear and stop.
2. **Claim it.** `update`: status `in-progress`, assignee `claude`, note
   `claimed`. Read it in full with `task`.
3. **Route it through the crew**, by the usual rules: search (`crew:scout`)
   before planning, plan (`crew:planner`, or `crew:architect` when it spans
   subsystems) before editing, `crew:coder` to build, `crew:reviewer` for
   anything with a branch or a loop. Skip stages the task does not need — a
   typo goes straight to `crew:quick`. Put `board task #<id>` in every brief so
   each agent logs its own milestone.
4. **Blocked on the developer** (a decision, access, credentials, an approval)
   → `update` with note `BLOCKED: <exactly what you need>` and assignee
   `owner`, tell the user the same in one line, and stop. Do not guess past it.
5. **Done** → run the project's checks, then `update`: status `completed`,
   note with what changed, the check result, and anything left over. Anything
   broken you found outside this task is already on the board as a `Bug`, or
   goes there now. Do not commit unless the user asked.
6. Report in two lines: the task, the outcome.

One task per run. Run it again for the next one.
