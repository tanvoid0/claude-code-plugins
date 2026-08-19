---
name: find-plugin
description: Search the awesomeclaudeplugins.com catalog for third-party Claude Code plugins and print install commands. Use when the user asks whether a plugin exists for a task, wants to find or discover plugins, or asks what is available for X.
---

# find-plugin

Check the built-ins first. `SearchPlugins` and `SearchSkills` cover the user's
own catalog and are cheaper and already vetted. Use this skill for the wider
public catalog (~33k GitHub repos), or when those return nothing.

Run `find.js`, which sits next to this SKILL.md. Use the absolute path of this
skill's directory — `$CLAUDE_PLUGIN_ROOT` is only set for hooks, not in the
shell, so it will not expand:

```bash
node "<this skill's directory>/find.js" -n 8 <search terms>
```

If that path is not to hand, find it with
`ls -d ~/.claude/plugins/cache/governor/governor/*/ | sort -V | tail -1`.

Queries are capped at 32 characters by the API, so use keywords, not sentences.

Then, in a few lines: which one or two actually fit the user's task, and what
each would cost them. Skip the rest rather than listing everything the search
returned.

## Do not install anything

Print the command, let the user run it. Installing a plugin registers hooks that
execute commands on their machine at every session start — that is a decision
they make after reading the repo, not one made for them mid-task.

If the user does ask you to install, that is their call: run the two commands
(`claude plugin marketplace add owner/repo`, then `claude plugin install
<plugin>@<marketplace>`), then run `claude plugin details <plugin>` and report
what it added and what it costs in always-on tokens.

Star counts come from the catalog and are accurate. They measure popularity, not
quality or safety.
