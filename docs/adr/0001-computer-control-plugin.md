# ADR 0001: Do not build a computer-control MCP; build a policy layer over the existing one

- Status: Accepted
- Date: 2026-08-30
- Deciders: Tanveer Hoque

## Context

We considered building a Claude Code plugin that drives the desktop: clicking,
typing, navigating, launching applications, and taking screenshots, with
privacy isolation so that a screenshot of one application does not leak the
contents of another, and with explicit approval before each class of action.

Claude Code already ships a `computer-use` MCP server that covers the driving
half of that description:

- `request_access` takes a list of applications and requires the user to
  approve each one explicitly. Screen capture and input are scoped to the
  granted set, so ungranted windows are not readable.
- Applications are granted at a tier derived from their category. Browsers are
  granted read-only (visible in screenshots, clicks and typing blocked).
  Terminals and IDEs are granted click-only (no typing, no right-click, no
  drag-drop). Everything else is granted full.
- `open_application`, `computer_batch` (click, type, key, scroll, drag),
  `read_clipboard` / `write_clipboard`, `switch_display`, and
  `teach_step` / `teach_batch` for demonstrated flows.
- Policy is enforced in the server, not only in the prompt: an action against
  an application whose tier forbids it returns an error.

Reimplementing this means reimplementing per-OS accessibility APIs, window-
scoped screen capture, and a native approval dialog — on Windows, macOS, and
Linux. That is a large, security-critical, native-code surface, and a second
implementation would be strictly worse than the one already audited and
shipped.

What the existing server does *not* provide is anything durable. Grants are
per-session and re-requested every time. There is no record of what was
clicked or typed. There is no way to declare an application permanently
off-limits. Screenshots enter the conversation at full fidelity, so whatever
text is on screen is now in context and in the transcript.

## Decision

Do not build a computer-control MCP server. Build a plugin that wraps the
existing `computer-use` server with durable policy, using only hooks and
skills — no native code, no new MCP server.

Scope, in priority order:

1. **Audit log.** A `PostToolUse` hook matching `mcp__computer-use__*` appends
   one line per action (timestamp, tool, target application, action kind) to a
   local append-only file. This is the prerequisite for trusting anything
   else: without it, nothing that happened is reviewable after the fact.
2. **Denylist.** A `PreToolUse` hook matching `mcp__computer-use__*` denies the
   call when the frontmost application matches a configured denylist —
   password managers, banking and brokerage applications, anything the user
   names. The MCP server's tiering is category-based and cannot express
   "never this specific application".
3. **Named grant profiles.** A skill plus a `computer-policy.json` that groups
   applications into named profiles, so a session starts by requesting one
   coherent set rather than a stream of one-off approvals. This reduces
   approval fatigue, which is itself the main practical failure mode of
   per-action consent.
4. **Screenshot redaction** (deferred). A hook that downscales or masks
   captures before they reach context. Deferred because the useful policy
   (which regions, which applications) is not yet known, and a bad redaction
   is worse than none.
5. **Task skills** (deferred). Encoded routines for repeated flows, so the
   model is not rediscovering a UI pixel by pixel each time. Deferred until
   there are observed repeated flows to encode — which requires (1) first.

Items 1-3 are in scope now. Items 4-5 are recorded here so that the reason
they were left out is on the record, and are not to be built speculatively.

## Consequences

Positive:

- No native code, no second implementation of screen capture or input
  injection, no new attack surface. The plugin is hooks and JSON.
- The security-critical part — isolation and consent — stays in the audited
  upstream server, and continues to improve without our involvement.
- The audit log makes the whole arrangement reviewable, which is the property
  a user actually needs in order to grant desktop access at all.

Negative:

- We are coupled to the `computer-use` tool names and to the shape of its
  inputs. A rename upstream breaks the hook matchers. Mitigation: the matcher
  is a prefix (`mcp__computer-use__*`) and the log is best-effort; a broken
  matcher degrades to no logging, and the denylist hook must fail closed.
- Hook-based denial happens in the client, not the server. It stops this
  client, not another one, and it is not a security boundary against a
  compromised host. It is a guardrail against mistakes, and should be
  documented as exactly that and nothing more.
- The denylist depends on identifying the frontmost application, which is
  platform-specific shell-out. It will need a per-platform branch, and must
  deny when it cannot determine the frontmost application.

## Alternatives considered

**Build a full computer-control MCP server.** Rejected. Months of native work
per platform to arrive at something already present, and a duplicate consent
mechanism is a liability rather than a feature.

**Fork the existing server and add policy inside it.** Rejected. Inherits the
maintenance burden of the native code without the upstream security review,
and diverges from what other Claude Code surfaces run.

**Do nothing — use `computer-use` bare.** Rejected. The gaps that matter
(no audit trail, no hard denylist) are the specific reasons a user would
decline to grant desktop access. Closing them is cheap; leaving them open
means the capability goes unused.
