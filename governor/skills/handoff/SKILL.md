---
name: handoff
description: Write a copy-pasteable handoff so unfinished work can continue in a fresh session instead of an expensive one. Use when the user says handoff, hand over, wrap up, /clear but keep the context, continue this tomorrow, or when a session has grown too big to keep working in.
---

# handoff

A long session is expensive because every turn re-reads all of it. The way out
is a fresh session — but only if the state survives the jump. That is this file.

Write `.claude/handoff.md` in the project root. Overwrite any existing one; it
describes the present, not a history. Keep it under ~80 lines: a handoff nobody
reads costs more than it saves.

```markdown
# Handoff — <one-line goal>

## State
<2-4 lines: what works now, what is half-done, what is untouched>

## Files that matter
- `path/to/file.ext:120` — what it does, what changed, what is left in it

## Decisions already made
- <decision> — because <reason>. Do not re-litigate.

## Next
1. <the first concrete action the next session should take>
2. ...

## Gotchas
- <the thing that wasted time this session>
```

Rules that make it worth its tokens:

- **Write for someone with no memory of this conversation.** No "as discussed",
  no "the file we looked at" — paths, names, line numbers.
- **Decisions with their reasons.** The expensive part of a session is not the
  edits, it is the reasoning that chose them. A next session that re-derives it
  pays twice.
- **Next steps as actions, not topics.** "Wire `AiChatExport` into
  `ai_assistant_page.dart`" beats "continue the chat export work".
- **Say what was ruled out.** Otherwise the next session tries it again.
- **Do not summarise the conversation.** Nobody needs the narrative, only the
  position.

Then tell the user, in one line, that it exists and that a fresh session should
start with: `read .claude/handoff.md`.

If nothing is outstanding, do not write the file — say the work is done.

Add `.claude/handoff.md` to `.gitignore` if the project does not already ignore
it, unless the user wants it committed for a teammate.
