# crew

Six subagents, each pinned to the cheapest model that holds for its job.

| agent | model | when |
|---|---|---|
| `quick` | haiku | mechanical, target already named. Typo, value change, rename, run a check. |
| `scout` | sonnet | "where does X live", "what would this touch". Read-only, returns file:line. |
| `coder` | sonnet | implementation against a settled plan or a clear task. |
| `planner` | opus | single-subsystem plan, bug-fix strategy. Read-only. |
| `reviewer` | opus | review a diff with real logic in it. Read-only. |
| `architect` | fable | spans subsystems, migrations, wire contracts. Read-only. |

Search before planning, plan before editing, review anything with a branch or a
loop in it. An agent handed work below its tier names the right agent and hands
back rather than doing it anyway.

The bodies are repo-agnostic: they defer to whatever `CLAUDE.md` the project
supplies for commands and conventions. A project's own
`.claude/agents/<name>.md` overrides the plugin file of the same name — put
repo-specific rules there.

## Board

The crew reports to Portal's task list, so you can see what is going on without
reading transcripts. A bundled MCP server (`mcp/portal.js`, Node 22+, no
dependencies) calls the daemon Portal runs on `127.0.0.1:18420`; set
`PORTAL_URL` to point elsewhere. Portal has to be running — the tools say so
plainly when it is not.

| tool | does |
|---|---|
| `projects` | Portal projects, filtered by name or path. |
| `tasks` | One project's board, or every project's with `project: "*"`. |
| `task` | One task: description, plan steps, progress log. |
| `add` | New item. `Bug` to raise an issue, `Subtask` + `parent_id` for a plan step. |
| `update` | Change status / assignee / priority, and append a progress note. |

`project` takes an id, a name, or a path — the deepest registered project that
contains the path wins. A progress note is a completed `Subtask` tagged `note`
under its task, so Portal's Tasks page shows the log as is.

Conventions the agents follow: assignee is whoever owns it (`claude`, `coder`,
…); `owner` means it is waiting on you, with a `BLOCKED:` note saying what for.
Brief an agent with `board task #<id>` and `coder`, `planner`, `architect` and
`reviewer` log their own milestone on it and raise out-of-scope problems as
`Bug`s.

| command | does |
|---|---|
| `/crew:work [id \| title]` | Claim the top open task (or the one named), route it through the crew, log milestones, close it. One task per run. |
| `/crew:standup [project]` | Waiting on you, in progress, open bugs, done this week. Offers one `/crew:work` session per project with queued work. |

Run one `/crew:work` session per project to have several employees at once.

`node mcp/portal.js --selftest` checks project resolution without Portal.

## Install

```bash
claude plugin marketplace add tanvoid0/claude-code-plugins
```

```bash
claude plugin install crew@tanvoid0
```

If you already have agents of the same name in `~/.claude/agents/`, remove those
files — otherwise you are maintaining two copies that will drift.
