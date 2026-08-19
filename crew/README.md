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

## Install

```bash
claude plugin marketplace add tanvoid0/claude-code-plugins
```

```bash
claude plugin install crew@tan
```

If you already have agents of the same name in `~/.claude/agents/`, remove those
files — otherwise you are maintaining two copies that will drift.
