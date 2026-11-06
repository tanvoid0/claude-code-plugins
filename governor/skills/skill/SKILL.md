---
name: skill
description: Load a parked skill on demand from ~/.claude/skills-parked and follow it for the rest of the session. Use when the user names a parked skill, asks what parked skills exist, or when a design, animation, branding or image-generation task would clearly be served by one.
---

# skill

Parked skills live in `~/.claude/skills-parked/<name>/SKILL.md`. They are not in
the session listing on purpose: 32 of them cost ~11k tokens per turn to
advertise, in every project, whether or not one ever fires.

**To load one:** Read `~/.claude/skills-parked/<name>/SKILL.md` and follow it as
if it had been invoked normally. It stays in effect for the rest of the session.
Read any file it points at only when it says to — the point of parking is to pay
for what gets used.

**To list what is there:** list the directories under `~/.claude/skills-parked/`.
Each has a `description:` line in its frontmatter's first few lines; report the
names with a short hint, not the full descriptions.

**If the name does not resolve exactly,** list the near matches and ask rather
than loading the wrong one — several are close cousins (`design`,
`design-system`, `design-taste-frontend`, `design-taste-frontend-v1`).

**To bring one back permanently** — it earns its listing cost in every session
from then on:

```bash
mv ~/.claude/skills-parked/<name> ~/.claude/skills/
```

Better, if it only matters in one project, put it where it fires and nowhere
else:

```bash
cp -r ~/.claude/skills-parked/<name> <project>/.claude/skills/
```
