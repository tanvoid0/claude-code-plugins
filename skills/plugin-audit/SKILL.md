---
name: plugin-audit
description: Report what every installed Claude Code plugin costs in always-on context tokens, and which to disable. Use when the user asks what their plugins cost, why sessions start heavy, to audit or prune plugins, or to cut token usage.
---

# plugin-audit

Run `audit.js`, which sits next to this SKILL.md. Use the absolute path of this
skill's directory — `$CLAUDE_PLUGIN_ROOT` is only set for hooks, not in the
shell, so it will not expand:

```bash
node "<this skill's directory>/audit.js"
```

If that path is not to hand, find it with
`ls -d ~/.claude/plugins/cache/governor/governor/*/ | sort -V | tail -1`.

It shells out to `claude plugin list` and `claude plugin details`, so it takes a
few seconds. Show the table as-is; it is already compact.

Then say which plugins to disable, and why. The rule is not "biggest is worst":

- **Always-on tokens** are paid in every session of every project, used or not.
  That is what pruning saves.
- A plugin used in most sessions earns its always-on cost. One used monthly does
  not — disable it and re-enable when needed (`claude plugin enable <name>`).
- **Hooks and MCP servers cost ~0 always-on.** Hooks run outside the model's
  context; MCP tool schemas load on demand. Never recommend disabling a plugin
  for its hooks or MCP servers.
- Skills and agents pay their description up front in every session and their
  body only when invoked. So many small skills can cost more than one large one.

Total always-on across all plugins is usually 1k–3k tokens. Say so plainly if
the total is already small: pruning a 2k always-on load matters far less than a
single unbounded agent run, and the honest answer is that there is nothing worth
cutting.

Do not disable anything without being asked. Print the commands and let the user
choose.
