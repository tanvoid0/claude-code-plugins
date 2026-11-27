#!/usr/bin/env node
// The crew's board: Portal's task list, over MCP (stdio, zero dependencies).
//
// Talks to the daemon Portal runs on loopback — POST /rpc/<command> — which
// trusts this machine, so no token. Every item is a Portal task linked to a
// project (resource_type "project"), tagged with the project's name so the
// Tasks page shows where it belongs. A progress note is a completed Subtask
// tagged "note" under the task it reports on: the log the developer reads.
//
// `node portal.js --selftest` checks project resolution without Portal.

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.env.PORTAL_URL || 'http://127.0.0.1:18420';
const STATUSES = ['pending', 'in-progress', 'completed', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high'];
const TYPES = ['Task', 'Bug', 'Story', 'Feature', 'Epic', 'Subtask'];
const OPEN = ['pending', 'in-progress'];

// Portal not answering: start the desktop app ourselves, once per server
// process, and wait for the daemon. PORTAL_EXE overrides the install path.
// ponytail: Windows default path only; set PORTAL_EXE elsewhere.
let launched = false;
async function startPortal() {
  if (launched) return;
  launched = true;
  const exe = process.env.PORTAL_EXE ||
    join(process.env.LOCALAPPDATA || '', 'Portal Desktop', 'portal_desktop.exe');
  if (!existsSync(exe)) return;
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { await fetch(`${BASE}/`); return; } catch {}
  }
}

async function rpc(command, args = {}) {
  const send = () => fetch(`${BASE}/rpc/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  let res;
  try {
    res = await send();
  } catch {
    await startPortal();
    try {
      res = await send();
    } catch {
      throw new Error(`Portal is not running and could not be started (nothing answers at ${BASE}). Start Portal, then retry.`);
    }
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Portal ${command}: ${body?.error ?? `HTTP ${res.status}`}`);
  return body;
}

// --- projects -------------------------------------------------------------

const segs = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().split('/');

function sharedTail(a, b) {
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
}

// id, exact name, or a path. A path resolves to the deepest registered project
// containing it; paths compare by shared trailing segments (>= 2) so a database
// written on another OS (/media/x/production/foo vs D:\projects\production\foo)
// still matches.
function findProject(all, ref) {
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) return all.find((p) => p.id === Number(s)) ?? null;
  const named = all.filter((p) => p.name.toLowerCase() === s.toLowerCase());
  if (named.length === 1) return named[0];
  const want = segs(s);
  const paths = all.map((p) => [p, segs(p.path)]);
  for (let n = want.length; n > 1; n--) {
    const dir = want.slice(0, n);
    let best = null;
    let bestTail = 1;
    for (const [p, have] of paths) {
      const t = sharedTail(dir, have);
      if (t > bestTail) [best, bestTail] = [p, t];
    }
    if (best) return best;
  }
  return null;
}

async function project(ref) {
  const all = await rpc('get_all_projects');
  const p = findProject(all, ref || process.cwd());
  if (!p) {
    throw new Error(
      `No Portal project matches "${ref || process.cwd()}". Pass a project id or name (see the projects tool), or add the folder in Portal.`,
    );
  }
  return p;
}

// --- formatting -----------------------------------------------------------

const tags = (t) => {
  try {
    return JSON.parse(t.tags ?? '[]');
  } catch {
    return [];
  }
};
const isNote = (t) => tags(t).includes('note');
const activeSession = (t) => {
  if (t.status !== 'in-progress') return null;
  const tag = tags(t).find((x) => x.startsWith('session:'));
  return tag ? tag.slice('session:'.length) : null;
};

// Rust checks title/description by UTF-8 byte length, not char count — slicing
// by .length and bolting on an ellipsis (itself 3 bytes) can push a "199-char"
// string past a 200-byte limit. Cut by bytes, on code-point boundaries.
function truncateBytes(str, maxBytes, suffix = '…') {
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let bytes = 0;
  let out = '';
  for (const ch of str) {
    bytes += Buffer.byteLength(ch, 'utf8');
    if (bytes > budget) break;
    out += ch;
  }
  return out + suffix;
}

function ago(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

const line = (t) =>
  `#${t.id} ${t.status} ${t.priority} ${t.type_ ?? 'Task'} "${t.title}"` +
  (t.assignee ? ` @${t.assignee}` : '') +
  (activeSession(t) ? ` 🟢${activeSession(t)}` : '') +
  ` · ${ago(t.updated_at ?? t.created_at)}`;

// --- tools ----------------------------------------------------------------

const projectArg = {
  type: 'string',
  description: 'Project id, exact name, or the repo path you are working in. Defaults to this server\'s working directory.',
};

const tools = [
  {
    name: 'projects',
    description: 'List Portal projects (id, name, path). Use to find the project id for a repo.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring of name or path.' },
        starred: { type: 'boolean', description: 'Only starred projects.' },
        dirty: { type: 'boolean', description: 'Only projects with uncommitted changes.' },
        unpushed: { type: 'boolean', description: 'Only projects with unpushed commits.' },
        risk: { type: 'string', description: 'Risk level, e.g. none, low, medium, high.' },
        activity: { type: 'string', description: 'Activity status, e.g. recent, stale.' },
        status: { type: 'string', description: 'Project status, e.g. active, archived.' },
        limit: { type: 'integer', description: 'Max rows. Default 50.' },
      },
    },
  },
  {
    name: 'create_project',
    description:
      'Register a repo folder as a Portal project so it can have a board. Call it only after the projects tool shows the folder is not registered. Returns the existing project if the exact path is already registered.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name. Default: the folder name.' },
        path: { type: 'string', description: 'Absolute folder path. Default: this server\'s working directory.' },
        description: { type: 'string' },
      },
    },
  },
  {
    name: 'tasks',
    description:
      'The board for one project, or every project with project="*": each task with status, priority, type, assignee, step progress and its latest progress note. Open tasks only unless done=true.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        done: { type: 'boolean', description: 'Also show tasks completed or cancelled in the last 7 days.' },
        status: { type: 'string', enum: STATUSES, description: 'Only this status (a closed one implies done).' },
        priority: { type: 'string', enum: PRIORITIES },
        type: { type: 'string', enum: TYPES },
        assignee: { type: 'string', description: 'Exact assignee, e.g. owner, claude, coder.' },
        search: { type: 'string', description: 'Substring of title or description.' },
        overdue: { type: 'boolean', description: 'Only tasks past their due date.' },
      },
    },
  },
  {
    name: 'runs',
    description: 'Recent Action Runs (commands run through Portal), newest first, optionally filtered. Use run_status with an id for the output.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'success, failed, running, cancelled.' },
        search: { type: 'string', description: 'Substring of the command or working directory.' },
        project: projectArg,
        limit: { type: 'integer', description: 'Default 20, max 200.' },
      },
    },
  },
  {
    name: 'automations',
    description: 'Portal automation workflows: the embedded engine and n8n. Says plainly when an engine is not running.',
    inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Substring of the workflow name.' } } },
  },
  {
    name: 'sdks',
    description: 'Installed SDK versions per version manager (nvm, rustup, sdkman). Read-only; installs and switches are done in Portal.',
    inputSchema: {
      type: 'object',
      properties: {
        manager: { type: 'string', description: 'One manager. Default: nvm, rustup and sdkman.' },
        available: { type: 'boolean', description: 'Also list versions available to install (needs manager; can be long, last 30 shown).' },
      },
    },
  },
  {
    name: 'task',
    description: 'One task in full: description, plan steps, and its progress log.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'add',
    description:
      'Put an item on the board. Raise an issue with type "Bug". Plan steps go in as type "Subtask" with parent_id. Assign to "owner" when it needs the developer (a decision, access, an approval).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Under 200 characters.' },
        description: { type: 'string', description: 'Under 1000 characters.' },
        type: { type: 'string', enum: TYPES, description: 'Default Task.' },
        priority: { type: 'string', enum: PRIORITIES, description: 'Default medium.' },
        status: { type: 'string', enum: STATUSES, description: 'Default pending.' },
        assignee: { type: 'string', description: 'Who owns it: an agent role (coder, reviewer, …), "claude", or "owner".' },
        parent_id: { type: 'integer', description: 'Makes this a step of that task; inherits its project.' },
        project: projectArg,
        session_id: {
          type: 'string',
          description:
            'External session id (e.g. this Claude session) claiming the task. Auto-cleared when status leaves in-progress; pass "" to clear it explicitly while still in-progress.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'update',
    description:
      'Change a task and/or append a progress note to its log. Notes are how the developer follows the work: one per milestone (claimed, plan settled, change landed with check result, blocked, done) — not per step. Blocked on the developer: note "BLOCKED: <what you need>" and assignee "owner".',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        note: { type: 'string', description: 'Progress note appended to the log.' },
        by: { type: 'string', description: 'Who is writing the note. Default: the task assignee.' },
        status: { type: 'string', enum: STATUSES },
        priority: { type: 'string', enum: PRIORITIES },
        assignee: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        session_id: {
          type: 'string',
          description:
            'External session id (e.g. this Claude session) claiming the task. Auto-cleared when status leaves in-progress; pass "" to clear it explicitly while still in-progress.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'run',
    description:
      'Run a shell command in a project folder through Portal, so it shows in Portal\'s Action Runs where the developer can watch the live output, stop it, or re-run it. Waits for it to finish (up to wait_seconds) and returns status + the end of the output. If the developer stops it, the result says STOPPED BY THE USER — do not retry unless they ask.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command, e.g. "pnpm lint".' },
        project: projectArg,
        cwd: { type: 'string', description: 'Run here instead of the project root.' },
        wait_seconds: { type: 'integer', description: 'How long to wait before returning while it keeps running. Default 120, max 600.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'project_update',
    description:
      'Change a Portal project: star or unstar, archive or restore, set its SDLC stage (idea, in_progress, stable, released; "" clears), rename, describe, or set build/start/test commands. Only the fields you pass change.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        starred: { type: 'boolean' },
        archived: { type: 'boolean' },
        stage: { type: 'string', description: 'idea, in_progress, stable, released, or "" to clear.' },
        name: { type: 'string' },
        description: { type: 'string' },
        build_command: { type: 'string' },
        start_command: { type: 'string' },
        test_command: { type: 'string' },
        refresh: { type: 'boolean', description: 'Re-read git and metadata from disk.' },
      },
    },
  },
  {
    name: 'release',
    description:
      "A project's release setup from .portal/pipeline.yml: the ship and rehearse plans, health issues, and recent release executions. Shipping is done in Portal only; rehearse with release_rehearse.",
    inputSchema: { type: 'object', properties: { project: projectArg } },
  },
  {
    name: 'release_rehearse',
    description: "Rehearse a project's release (a dry run of its release workflow) and wait for the result, like pipeline_run. Runs commands on this machine.",
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        variables: { type: 'object', additionalProperties: { type: 'string' } },
        wait_seconds: { type: 'integer', description: 'Default 120, max 600.' },
      },
    },
  },
  {
    name: 'deployments',
    description: 'Portal deployments (id, name, status, port, container) and Docker status, or with containers=true every Docker container. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Only this project (id, name or path).' },
        containers: { type: 'boolean', description: 'List Docker containers instead.' },
      },
    },
  },
  {
    name: 'deployment_control',
    description: 'Start or stop a Portal deployment, or read the tail of its logs.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Deployment id from deployments.' },
        action: { type: 'string', enum: ['start', 'stop', 'logs'] },
        tail: { type: 'integer', description: 'Log lines for logs. Default 80.' },
      },
      required: ['id', 'action'],
    },
  },
  {
    name: 'container_control',
    description: 'Start or stop a Docker container by id (from deployments with containers=true).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, action: { type: 'string', enum: ['start', 'stop'] } },
      required: ['id', 'action'],
    },
  },
  {
    name: 'custom_scripts',
    description: "Portal's saved script library (id, name, command, run count), or one script in full with id. Run one with custom_script_run.",
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string' }, id: { type: 'integer' } },
    },
  },
  {
    name: 'custom_script_run',
    description:
      'Run a saved library script through Portal (shows in Action Runs), like run. Refuses scripts that need sudo or an interactive terminal, and scripts that take parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        project: projectArg,
        cwd: { type: 'string' },
        wait_seconds: { type: 'integer' },
      },
      required: ['id'],
    },
  },
  {
    name: 'workflow_run',
    description: 'Run an embedded automation workflow (ids from automations) in a project folder and return its result. n8n workflows are not triggered from here.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        project: projectArg,
        variables: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'run_cancel',
    description: 'Stop a run started with the run tool (or any running Action Run) by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'env',
    description:
      'This machine\'s persistent environment variables (user and system scope). Lists names only; values stay hidden unless you pass name and reveal=true. Read-only: Portal edits them, this does not.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Substring of the variable name.' },
        scope: { type: 'string', enum: ['user', 'system'] },
        name: { type: 'string', description: 'Exact variable name to show.' },
        reveal: { type: 'boolean', description: 'With name: show the value. Off by default; many hold secrets.' },
      },
    },
  },
  {
    name: 'env_backup',
    description:
      'Back up projects\' .env* files into the Portal vault (each an encrypted credential row — never a file, never a tarball, never GitHub). action "scan" (default) lists every project\'s env files and whether each is backed up; it is read-only and works with the vault LOCKED. action "import" backs up disk → vault (new files created, unchanged skipped, a differing vault copy kept not replaced); it needs the vault unlocked once in Portal Desktop and reports clearly if it is locked instead of hanging. Restore (vault → disk) is destructive and lives only in the Portal UI, not here. Never prints .env values.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['scan', 'import'],
          description: 'scan (default, read-only, works locked) or import (back up disk to vault; needs the vault unlocked).',
        },
      },
    },
  },
  {
    name: 'programs',
    description:
      'Installed Windows programs (what Add/Remove Programs shows), with size, publisher and whether a silent uninstall exists. Read-only. The id returned is what uninstall and program_leftovers take.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Substring of the name or publisher.' },
        system: { type: 'boolean', description: 'Include hidden system components. Off by default.' },
      },
    },
  },
  {
    name: 'program_leftovers',
    description:
      'Scan for folders and registry keys a program leaves behind (install folder, AppData, ProgramData, Software\<name> keys). Read-only; works before or after uninstalling.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Id from programs.' } }, required: ['id'] },
  },
  {
    name: 'uninstall',
    description:
      'DESTRUCTIVE. Run a program uninstaller (the one it registered) on this machine (blocks until it exits; may raise a UAC prompt or dialog). With cleanup=true, also removes everything program_leftovers lists, after the uninstall succeeds: folders go to the Recycle Bin, registry keys are exported to a backup first. Confirm with the user before calling, and show them program_leftovers first if cleaning up.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id from programs.' },
        silent: { type: 'boolean', description: 'No dialogs, where the program supports it (see programs).' },
        cleanup: { type: 'boolean', description: 'Remove leftovers after a successful uninstall.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'dev_cleaners',
    description:
      'Reclaimable developer junk on this machine (package caches, build output, container leftovers) with sizes and risk. Read-only. Pass roots to also walk folders for project artifacts (node_modules, target/...). Ids feed dev_clean.',
    inputSchema: { type: 'object', properties: { roots: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'dev_clean',
    description:
      'DESTRUCTIVE. Remove dev_cleaners items by id (Recycle Bin unless permanent=true; container resources are always permanent). Items are re-scanned, so only real cleaner items can be removed. Confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        roots: { type: 'array', items: { type: 'string' }, description: 'Same roots you scanned with, if any.' },
        permanent: { type: 'boolean' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'relocatable',
    description:
      'Tools whose big data folder (Ollama models, Gradle, Android emulators, npm/cargo/Hugging Face caches) can be moved to another drive and repointed with a user env var. With toolId + targetRoot it returns the exact plan (size, steps, blockers such as the tool still running). Read-only. Feeds relocate.',
    inputSchema: {
      type: 'object',
      properties: {
        toolId: { type: 'string', description: 'Id from the list; omit to list all.' },
        targetRoot: { type: 'string', description: 'Destination parent folder, e.g. I:\build. Required with toolId.' },
      },
    },
  },
  {
    name: 'relocate',
    description:
      'DESTRUCTIVE. MOVES a tool data folder to targetRoot and sets a user env var so the tool uses it. Refuses while the tool is running (close it first; never kill it yourself without asking). Run relocatable with the same args first and confirm the plan with the user. The tool and any terminal/IDE launching it must be restarted afterwards.',
    inputSchema: {
      type: 'object',
      properties: { toolId: { type: 'string' }, targetRoot: { type: 'string' } },
      required: ['toolId', 'targetRoot'],
    },
  },
  {
    name: 'sdk_install',
    description:
      'Install an SDK version through a version manager (nvm, rustup, sdkman). Downloads and runs the manager on this machine; can take minutes. Use sdks with available=true to see versions.',
    inputSchema: {
      type: 'object',
      properties: { manager: { type: 'string', description: 'nvm, rustup or sdkman.' }, version: { type: 'string' } },
      required: ['manager', 'version'],
    },
  },
  {
    name: 'sdk_switch',
    description: 'Make an installed version the active one for a version manager. Affects every new shell on this machine, not just one project.',
    inputSchema: {
      type: 'object',
      properties: { manager: { type: 'string', description: 'nvm, rustup or sdkman.' }, version: { type: 'string' } },
      required: ['manager', 'version'],
    },
  },
  {
    name: 'pipelines',
    description:
      'Pipelines of a project (id, name, step count), or one pipeline in full with id: its steps, dependencies, commands and variables. Use the id with pipeline_run.',
    inputSchema: {
      type: 'object',
      properties: { project: projectArg, id: { type: 'integer', description: 'Pipeline id: show its steps and variables.' } },
    },
  },
  {
    name: 'pipeline_run',
    description:
      'Start a pipeline through Portal and wait for it (up to wait_seconds): status, per-step result, and the failing step\'s output. Shows live in Portal\'s Action Runs; the developer can stop it. If it comes back STOPPED BY THE USER, do not retry unless they ask. Steps run commands on this machine.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Pipeline id from the pipelines tool.' },
        variables: { type: 'object', additionalProperties: { type: 'string' }, description: 'Pipeline variable overrides.' },
        wait_seconds: { type: 'integer', description: 'Default 120, max 600.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'pipeline_status',
    description:
      'One pipeline execution by execution_id: status, steps, and the output of the failed step (or step_id). With pipeline_id instead: that pipeline\'s recent executions.',
    inputSchema: {
      type: 'object',
      properties: {
        execution_id: { type: 'string' },
        pipeline_id: { type: 'integer', description: 'List this pipeline\'s recent executions.' },
        step_id: { type: 'string', description: 'Show this step\'s log tail instead of the failed one.' },
        limit: { type: 'integer', description: 'Executions to list. Default 10.' },
      },
    },
  },
  {
    name: 'pipeline_cancel',
    description: 'Stop a running pipeline execution.',
    inputSchema: { type: 'object', properties: { execution_id: { type: 'string' } }, required: ['execution_id'] },
  },
  {
    name: 'run_status',
    description: 'Status and the end of the output of a run started with the run tool (still running, finished, failed, or stopped by the user).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Run id from the run tool.' } }, required: ['id'] },
  },
  {
    name: 'db',
    description:
      'Read-only look into Portal\'s Database Explorer sources (SQLite, Postgres, MySQL). action "sources" (default) lists them; "tables" and "describe" (table) show the schema; "rows" (table, limit, offset) pages a table; "query" runs one SELECT (max 200 rows, flagged when truncated). Writes are refused; tables holding credentials or the vault are off limits.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['sources', 'tables', 'describe', 'rows', 'query'] },
        source: { type: 'string', description: 'Source id from action "sources".' },
        table: { type: 'string', description: 'For describe and rows.' },
        sql: { type: 'string', description: 'For query: a single SELECT (or WITH ... SELECT).' },
        limit: { type: 'integer', description: 'Rows for "rows". Default 50, max 200.' },
        offset: { type: 'integer', description: 'First row for "rows". Default 0.' },
      },
    },
  },
  {
    name: 'docs',
    description:
      'Portal documents. action "list" (default, newest first; query to search), "get" (id, full content, long ones cut), "create" (title, content, tags), "update" (id plus any of title, content, tags, archived; content replaces the whole text). No delete.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update'] },
        id: { type: 'integer', description: 'Document id, for get and update.' },
        query: { type: 'string', description: 'For list: search the documents.' },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        archived: { type: 'boolean' },
      },
    },
  },
  {
    name: 'k8s',
    description:
      'Read-only Kubernetes in Portal. action "clusters" (default) lists kubeconfig clusters and which is connected; once one is connected in Portal: "namespaces", "pods", "deployments", "events" (namespace optional) and "logs" (namespace, pod, container, tail). Never connects or changes anything; secrets and configmaps are not exposed.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['clusters', 'namespaces', 'pods', 'deployments', 'events', 'logs'] },
        namespace: { type: 'string', description: 'Default: all namespaces. Required for logs.' },
        pod: { type: 'string', description: 'For logs.' },
        container: { type: 'string', description: 'For logs, when the pod has several.' },
        tail: { type: 'integer', description: 'Log lines. Default 80, max 500.' },
        limit: { type: 'integer', description: 'Rows for lists. Default 50, max 200.' },
      },
    },
  },
];

// --- runs -----------------------------------------------------------------

let clientName = 'mcp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINISHED = ['success', 'failed', 'cancelled'];

// What a terminal would show: escape codes gone, a \r redraw keeps its last state.
function terminalText(raw) {
  return raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\r+$/, '').split('\r').pop())
    .join('\n');
}

// A run that failed before printing anything (missing working directory, spawn failure) has only
// run.error to say why. With output, run.error is "Exit code N" plus that same tail, so it is left out.
const failureNote = (run, out) => {
  const why = run.status === 'failed' && !out ? terminalText(String(run.error ?? '')).trim() : '';
  return why ? `\n--- error ---\n${why}` : '';
};

async function describeRun(id) {
  const run = await rpc('get_script_execution', { execution_id: id });
  if (!run) throw new Error(`No run ${id} (it may have been deleted in Portal).`);
  const status = run.status;
  const raw = FINISHED.includes(status)
    ? run.output ?? ''
    : (await rpc('get_script_execution_live_output', { execution_id: id })).join('');
  const out = terminalText(raw).trim().split('\n').slice(-60).join('\n');
  const head =
    status === 'cancelled'
      ? `STOPPED BY THE USER in Portal (${run.error ?? 'Stopped by user'}). Do not retry unless they ask.`
      : status === 'success'
        ? `Succeeded (exit ${run.exitCode ?? 0}).`
        : status === 'failed'
          ? `Failed (exit ${run.exitCode ?? '?'}).`
          : `Still running — check again with run_status id="${id}".`;
  return `${head}\nrun ${id} · ${run.command}\nIn Portal: Action Runs → /pipeline-runs/${id}${out ?`\n--- output (tail) ---\n${out}` : ''}${failureNote(run, out)}`;
}

const tail = (raw, n = 40) => terminalText(String(raw ?? '')).trim().split('\n').slice(-n).join('\n');

async function describeExecution(id, stepId) {
  const e = await rpc('get_pipeline_execution', { execution_id: id });
  if (!e) throw new Error(`No pipeline execution ${id}.`);
  const steps = e.stepExecutions ?? [];
  const head =
    e.status === 'cancelled'
      ? `STOPPED BY THE USER in Portal. Do not retry unless they ask.`
      : e.status === 'success'
        ? 'Succeeded.'
        : e.status === 'failed'
          ? `Failed${e.error ? `: ${e.error}` : '.'}`
          : `Still ${e.status} (${Math.round(e.progress?.percent ?? 0)}%) — check again with pipeline_status execution_id="${id}".`;
  const rows = steps.map((s) => `  ${s.status.padEnd(9)} ${s.stepName ?? s.stepId}${s.exitCode != null ? ` (exit ${s.exitCode})` : ''}${s.duration ? ` ${Math.round(s.duration / 1000)}s` : ''}`);
  const pick = stepId ? steps.find((s) => s.stepId === stepId) : steps.find((s) => s.status === 'failed');
  let out = '';
  if (pick) {
    const logs = await rpc('get_step_execution_logs', { execution_id: id, step_id: pick.stepId }).catch(() => []);
    out = tail(logs.length ? logs.join('') : pick.output);
  }
  return [
    `${head}\nexecution ${id} · pipeline ${e.pipelineName ?? e.pipelineId ?? '?'} · ${e.status}`,
    rows.join('\n'),
    out ? `--- ${pick.stepName ?? pick.stepId} output (tail) ---\n${out}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// db / docs / k8s share these: cap a block of text, cap a list.
const clip = (str, n = 20000) => (str.length > n ? `${str.slice(0, n)}\n…truncated (${str.length - n} more chars).` : str);
const lines = (list, n, f) => list.slice(0, n).map(f).join('\n') + (list.length > n ? `\n…${list.length - n} more; narrow it or raise limit.` : '');
const cap = (limit) => Math.min(Math.max(limit ?? 50, 1), 200);

// db: Portal's own database holds the vault and tokens; keep those tables out of reach.
// ponytail: name match on the text, so a harmless column called "secret" is refused too; no SQL parser.
const DB_SECRET = /credential|vault|secret|github_connections|device_approvals|project_env|sdk_environment_variables/i;
const cell = (v) => {
  const t = v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
};

// One statement, SELECT or WITH ... SELECT, no write keyword. Defence in depth: SQLite opens
// read-only and the server drivers wrap the text in SELECT * FROM (...).
function readOnlySql(sql) {
  const s = String(sql)
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`/g, "''")
    .trim()
    .replace(/;+$/, '')
    .trim();
  if (!/^(select|with)\b/i.test(s) || s.includes(';') || /\b(insert|update|delete|drop|alter|create|attach|pragma|truncate|into|merge)\b/i.test(s)) {
    throw new Error('db runs a single read-only SELECT (or WITH ... SELECT); writes are not available here.');
  }
}

const handlers = {
  async pipelines({ project: ref, id }) {
    if (id) {
      const p = await rpc('get_pipeline', { pipeline_id: String(id) });
      if (!p) throw new Error(`No pipeline ${id}.`);
      const vars = (p.variables ?? []).map((v) => `${v.name ?? v.key}${v.defaultValue != null ? `=${v.defaultValue}` : ''}`);
      return [
        `${p.id} ${p.name}${p.enabled === false ? ' (disabled)' : ''}${p.description ? ` — ${p.description}` : ''}`,
        'Steps:',
        ...(p.steps ?? []).map((s) => `  ${s.id} ${s.name ?? ''}${s.dependsOn?.length ? ` after ${s.dependsOn.join(',')}` : ''}: ${s.config?.command ?? '(no command)'}`),
        vars.length ? `Variables: ${vars.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    const p = await project(ref);
    const list = await rpc('get_pipelines', { project_id: p.id });
    return (
      list.map((x) => `${x.id} ${x.name} [${(x.steps ?? []).length} steps${x.enabled === false ? ', disabled' : ''}]`).join('\n') ||
      `${p.name}: no pipelines.`
    );
  },

  async pipeline_run({ id, variables, wait_seconds }) {
    const e = await rpc('execute_pipeline', { request: { pipelineId: String(id), ...(variables ? { variables } : {}) } });
    const deadline = Date.now() + Math.min(Math.max(wait_seconds ?? 120, 1), 600) * 1000;
    let cur = e;
    while (!FINISHED.includes(cur?.status) && Date.now() < deadline) {
      await sleep(1000);
      cur = (await rpc('get_pipeline_execution', { execution_id: e.id })) ?? cur;
    }
    return describeExecution(e.id);
  },

  async pipeline_status({ execution_id, pipeline_id, step_id, limit }) {
    if (execution_id) return describeExecution(execution_id, step_id);
    if (!pipeline_id) throw new Error('Pass execution_id, or pipeline_id to list its executions.');
    const list = await rpc('get_pipeline_executions', { pipeline_id: String(pipeline_id), limit: Math.min(limit ?? 10, 100) });
    return list.map((e) => `${e.id} ${e.status} ${ago(e.startedAt)}${e.triggeredBy ? ` by ${e.triggeredBy}` : ''}`).join('\n') || 'No executions.';
  },

  async pipeline_cancel({ execution_id }) {
    await rpc('cancel_pipeline_execution', { execution_id });
    return `Cancel requested for ${execution_id}.\n${await describeExecution(execution_id)}`;
  },

  async run({ command, project: ref, cwd, wait_seconds }) {
    const dir = cwd || (await project(ref)).path;
    const id = await rpc('execute_script', {
      params: { command, workingDirectory: dir, env: { CI: 'true' }, triggeredBy: `mcp:${clientName}` },
    });
    const deadline = Date.now() + Math.min(Math.max(wait_seconds ?? 120, 1), 600) * 1000;
    while (Date.now() < deadline) {
      const run = await rpc('get_script_execution', { execution_id: id });
      if (!run || FINISHED.includes(run.status)) break;
      await sleep(1000);
    }
    return describeRun(id);
  },

  async run_status({ id }) {
    return describeRun(id);
  },

  async projects({ query, starred, dirty, unpushed, risk, activity, status, limit }) {
    const all = await rpc('get_all_projects');
    const q = (query ?? '').toLowerCase();
    const eq = (a, b) => String(a ?? '').toLowerCase() === b.toLowerCase();
    const hits = all
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      .filter((p) => starred === undefined || !!p.starred === starred)
      .filter((p) => dirty === undefined || !!p.has_uncommitted_changes === dirty)
      .filter((p) => unpushed === undefined || p.unpushed_commits > 0 === unpushed)
      .filter((p) => !risk || eq(p.risk_level, risk))
      .filter((p) => !activity || eq(p.activity_status, activity))
      .filter((p) => !status || eq(p.status, status));
    const max = Math.min(limit ?? 50, 200);
    const extra = (p) => {
      const bits = [
        p.git_branch,
        p.has_uncommitted_changes && 'dirty',
        p.unpushed_commits > 0 && `${p.unpushed_commits} unpushed`,
        p.starred && 'starred',
        p.risk_level && p.risk_level !== 'none' && `risk:${p.risk_level}`,
      ].filter(Boolean);
      return bits.length ? ` [${bits.join(', ')}]` : '';
    };
    const shown = hits.slice(0, max).map((p) => `${p.id} ${p.name} — ${p.path}${extra(p)} portal://project/${p.id}`);
    return [...shown, hits.length > max ? `…${hits.length - max} more; narrow the filter.` : ''].join('\n').trim() || 'No projects match.';
  },

  async runs({ status, search, project: ref, limit }) {
    const norm = (s) => String(s ?? '').toLowerCase().replace(/\\/g, '/');
    const dir = ref ? norm((await project(ref)).path) : null;
    const q = (search ?? '').toLowerCase();
    const hits = (await rpc('get_recent_script_executions', { limit: 200 }))
      .filter((r) => !status || r.status === status)
      .filter((r) => !q || `${r.command} ${r.workingDirectory}`.toLowerCase().includes(q))
      .filter((r) => !dir || norm(r.workingDirectory).startsWith(dir))
      .slice(0, Math.min(limit ?? 20, 200));
    return (
      hits
        .map((r) => `${r.id} ${r.status}${r.exitCode != null ? ` (exit ${r.exitCode})` : ''} "${r.command}" in ${r.workingDirectory}`)
        .join('\n') || 'No runs match.'
    );
  },

  async automations({ search }) {
    const q = (search ?? '').toLowerCase();
    const name = (w) => String(w.name ?? w.id ?? JSON.stringify(w));
    const out = [];
    for (const [label, cmd] of [['embedded', 'list_embedded_workflows'], ['n8n', 'list_available_workflows']]) {
      try {
        const list = (await rpc(cmd)).filter((w) => !q || name(w).toLowerCase().includes(q));
        out.push(`${label}: ${list.length ? list.map((w) => `${w.id ?? ''} ${name(w)}${w.active === false ? ' (inactive)' : ''}`.trim()).join('; ') : 'none'}`);
      } catch (e) {
        out.push(`${label}: unavailable (${e.message})`);
      }
    }
    return out.join('\n');
  },

  async project_update({ project: ref, starred, archived, stage, refresh, ...f }) {
    const p = await project(ref);
    const did = [];
    if (starred !== undefined && !!p.starred !== starred) {
      await rpc('toggle_project_star', { id: p.id });
      did.push(starred ? 'starred' : 'unstarred');
    }
    if (archived !== undefined) {
      await rpc('set_project_archived', { id: p.id, archived });
      did.push(archived ? 'archived' : 'restored');
    }
    if (stage !== undefined) {
      await rpc('set_project_stage', { id: p.id, stage: stage || null });
      did.push(`stage ${stage || 'cleared'}`);
    }
    const fields = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
    if (Object.keys(fields).length) {
      await rpc('update_project', { id: p.id, ...fields });
      did.push(`updated ${Object.keys(fields).join(', ')}`);
    }
    if (refresh) {
      await rpc('refresh_project_metadata', { id: p.id });
      did.push('refreshed');
    }
    return `${p.name}: ${did.join('; ') || 'nothing to change'}.`;
  },

  async release({ project: ref }) {
    const p = await project(ref);
    const d = await rpc('release_describe', { project_id: p.id });
    if (!d) return `${p.name}: no release configured (.portal/pipeline.yml has no release: block).`;
    const plan = (x) => (x?.steps ?? []).map((s) => `    ${s.id}: ${s.command ?? ''}${s.dependsOn?.length ? ` (after ${s.dependsOn.join(',')})` : ''}`).join('\n');
    const health = await rpc('release_health', { project_id: p.id }).catch(() => []);
    const runs = await rpc('release_list', { project_id: p.id, limit: 5 }).catch(() => []);
    return [
      `${p.name} release`,
      `  ship:\n${plan(d.ship)}`,
      d.rehearse ? `  rehearse:\n${plan(d.rehearse)}` : '  no rehearse workflow',
      health.length ? `Health:\n${health.map((i) => `  ${i.severity ?? ''} ${i.message ?? JSON.stringify(i)}`).join('\n')}` : 'Health: ok',
      runs.length ? `Recent:\n${runs.map((e) => `  ${e.id} ${e.status} ${ago(e.startedAt)}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  },

  async release_rehearse({ project: ref, variables, wait_seconds }) {
    const p = await project(ref);
    const e = await rpc('release_rehearse', { project_id: p.id, ...(variables ? { variables } : {}) });
    const deadline = Date.now() + Math.min(Math.max(wait_seconds ?? 120, 1), 600) * 1000;
    let cur = e;
    while (!FINISHED.includes(cur?.status) && Date.now() < deadline) {
      await sleep(1000);
      cur = (await rpc('get_pipeline_execution', { execution_id: e.id })) ?? cur;
    }
    return describeExecution(e.id);
  },

  async deployments({ project: ref, containers }) {
    if (containers) {
      const list = await rpc('list_containers_command');
      return list.map((c) => `${String(c.id).slice(0, 12)} ${c.name} ${c.image} — ${c.status}${c.ports?.length ? ` [${c.ports.join(', ')}]` : ''}`).join('\n') || 'No containers.';
    }
    const dock = await rpc('get_docker_status_command').catch((e) => ({ message: e.message }));
    const pid = ref ? String((await project(ref)).id) : null;
    const list = (await rpc('get_deployments_command')).filter((d) => !pid || String(d.project_id) === pid);
    const head = `docker: ${dock.running ? 'running' : dock.installed === false ? 'not installed' : 'not running'}${dock.version ? ` ${dock.version}` : ''}`;
    return [head, ...list.map((d) => `${d.id} ${d.name} ${String(d.status)}${d.exposed_port ? ` :${d.exposed_port}` : ''}${d.container_id ? ` container ${String(d.container_id).slice(0, 12)}` : ''}`)].join('\n');
  },

  async deployment_control({ id, action, tail: n }) {
    if (action === 'logs') return tail((await rpc('get_deployment_logs_command', { deployment_id: id, tail: n ?? 80 })).join('\n'), n ?? 80) || 'No logs.';
    const d = await rpc(action === 'start' ? 'start_deployment_command' : 'stop_deployment_command', { deployment_id: id });
    return `${d.name}: ${String(d.status)}`;
  },

  async container_control({ id, action }) {
    await rpc(action === 'start' ? 'start_container_command' : 'stop_container_command', { container_id: id });
    return `Container ${id}: ${action} requested.`;
  },

  async custom_scripts({ search, id }) {
    if (id) {
      const s = await rpc('get_custom_script', { id });
      if (!s) throw new Error(`No script ${id}.`);
      return `${s.id} ${s.name}${s.description ? ` — ${s.description}` : ''}\n$ ${s.command}\nparams: ${s.parameters_json || '[]'}${s.requires_sudo ? ' · needs sudo' : ''}${s.is_interactive ? ' · interactive' : ''} · ${s.run_count} runs`;
    }
    const q = (search ?? '').toLowerCase();
    return (
      (await rpc('get_all_custom_scripts'))
        .filter((s) => !q || `${s.name} ${s.command} ${s.category ?? ''}`.toLowerCase().includes(q))
        .map((s) => `${s.id} ${s.name}${s.category ? ` [${s.category}]` : ''}: ${s.command.split('\n')[0].slice(0, 80)} (${s.run_count} runs)`)
        .join('\n') || 'No scripts.'
    );
  },

  async custom_script_run({ id, project: ref, cwd, wait_seconds }) {
    const s = await rpc('get_custom_script', { id });
    if (!s) throw new Error(`No script ${id}.`);
    if (s.requires_sudo || s.is_interactive) throw new Error(`"${s.name}" needs sudo or an interactive terminal — run it in Portal.`);
    let params = [];
    try {
      params = JSON.parse(s.parameters_json || '[]');
    } catch {}
    if (params.length) throw new Error(`"${s.name}" takes parameters (${params.map((x) => x.name ?? x.key).join(', ')}); run it in Portal, or use run with the filled-in command.`);
    return handlers.run({ command: s.command, project: ref, cwd, wait_seconds });
  },

  async workflow_run({ id, project: ref, variables }) {
    const p = ref ? await project(ref) : null;
    const r = await rpc('execute_embedded_workflow', { workflow_id: id, project_path: p?.path ?? null, variables: variables ?? null });
    return JSON.stringify(r, null, 1).slice(0, 3000);
  },

  async run_cancel({ id }) {
    await rpc('cancel_script_execution', { execution_id: id });
    return describeRun(id);
  },

  async env({ search, scope, name, reveal }) {
    const q = (search ?? '').toLowerCase();
    const hits = (await rpc('env_list_variables'))
      .filter((v) => !scope || v.scope === scope)
      .filter((v) => !name || v.name.toLowerCase() === name.toLowerCase())
      .filter((v) => !q || v.name.toLowerCase().includes(q));
    if (!hits.length) return 'No variables match.';
    return hits
      .map((v) => `${v.scope.padEnd(6)} ${v.name}${name && reveal ? `=${v.value}` : name ? ' (value hidden; reveal=true to show)' : ''}`)
      .join('\n');
  },

  // One file = one encrypted vault credential. Never emits .env values: the scan and
  // report carry names, relative paths and states only.
  async env_backup({ action }) {
    const STATE = {
      new: 'not backed up',
      inSync: 'in sync',
      differs: 'differs',
      onlyInVault: 'only in vault',
      unknown: 'unknown (vault locked)',
    };
    const fmtScan = (scan) => {
      const files = scan.files ?? [];
      const counts = {};
      for (const f of files) counts[f.state] = (counts[f.state] ?? 0) + 1;
      const head = scan.vaultLocked
        ? 'Vault is LOCKED. Files present on both sides read "unknown" until it is unlocked in Portal Desktop; scan itself never prompts.'
        : 'Vault is unlocked.';
      const summary = files.length
        ? Object.entries(counts).map(([s, n]) => `${n} ${STATE[s] ?? s}`).join(', ')
        : 'no .env files found';
      const lines = files.map((f) => `${f.projectName}/${f.relPath} — ${STATE[f.state] ?? f.state}`);
      const extra = [];
      if (scan.skipped?.length) extra.push(`Not backed up (not UTF-8 text, or over 1 MiB): ${scan.skipped.join('; ')}`);
      if (scan.unmatched?.length)
        extra.push(`${scan.unmatched.length} vault ${scan.unmatched.length === 1 ? 'entry has' : 'entries have'} no project on this machine.`);
      return [head, `${files.length} file(s): ${summary}`, ...lines, ...extra].join('\n');
    };

    if ((action ?? 'scan') === 'import') {
      // Scan first so a locked vault is reported, not met with the up-to-120s unlock prompt.
      const scan = await rpc('env_backup_scan');
      if (scan.vaultLocked)
        return 'Portal vault is locked — unlock once in Portal Desktop, then retry. (scan works while locked; import does not.)';
      // files:null backs up every file found, overwrite off: new rows are created, a
      // differing vault copy is kept (conflict), never replaced. Overwrite/restore is UI-only.
      const items = (await rpc('env_backup_import', { files: null })).items ?? [];
      const counts = {};
      for (const i of items) counts[i.outcome] = (counts[i.outcome] ?? 0) + 1;
      const summary = Object.entries(counts).map(([o, n]) => `${n} ${o}`).join(', ') || 'nothing to do';
      const changed = items
        .filter((i) => i.outcome !== 'unchanged' && i.outcome !== 'identical')
        .map((i) => `${i.outcome}: ${i.projectName}/${i.relPath}${i.detail ? ` (${i.detail})` : ''}`);
      return [`Backed up disk → vault. ${summary}.`, ...changed].join('\n');
    }

    return fmtScan(await rpc('env_backup_scan'));
  },

  async programs({ search, system }) {
    const q = (search ?? '').toLowerCase();
    const hits = (await rpc('uninstaller_list_programs'))
      .filter((p) => system || !p.systemComponent)
      .filter((p) => !q || `${p.name} ${p.publisher}`.toLowerCase().includes(q));
    if (!hits.length) return 'No programs match.';
    return hits
      .slice(0, 200)
      .map((p) => `${p.name} ${p.version} | ${p.publisher || '-'} | ${p.sizeKb ? Math.round(p.sizeKb / 1024) + ' MB' : '?'} | ${p.isMsi || p.quietUninstallString ? 'silent ok' : 'no silent'}\n  id: ${p.id}`)
      .join('\n');
  },

  async program_leftovers({ id }) {
    const l = await rpc('uninstaller_scan_leftovers', { id });
    if (!l.length) return 'No leftovers found.';
    return l.map((x) => `${x.kind.padEnd(8)} ${x.path}${x.kind === 'folder' ? ` (${(x.sizeBytes / 1048576).toFixed(1)} MB)` : ''}`).join('\n');
  },

  async uninstall({ id, silent, cleanup }) {
    // Leftovers are scanned before uninstalling: the registry entry they key off disappears with the program.
    const paths = cleanup ? (await rpc('uninstaller_scan_leftovers', { id })).map((x) => x.path) : null;
    const r = await rpc('uninstaller_run', { id, silent: !!silent, cleanup_paths: paths });
    const out = [`${r.message} (exit ${r.exitCode ?? '?'})`];
    if (r.cleanup) {
      out.push(`removed ${r.cleanup.removed.length}, failed ${r.cleanup.failed.length}`, ...r.cleanup.failed.map((f) => `  ${f}`));
      if (r.cleanup.backupDir) out.push(`registry backups: ${r.cleanup.backupDir}`);
    }
    return out.join('\n');
  },

  async dev_cleaners({ roots }) {
    const s = await rpc('scan_dev_cleaners', { roots: roots ?? null });
    return s.groups
      .map((g) => [
        `${g.label}${g.available ? '' : ` (unavailable: ${g.unavailableReason})`} - ${(g.totalBytes / 1048576).toFixed(0)} MB`,
        ...g.items.slice(0, 15).map((i) => `  ${i.id} | ${(i.sizeBytes / 1048576).toFixed(1)} MB | ${JSON.stringify(i.risk)} | ${i.path}`),
      ].join('\n'))
      .join('\n');
  },

  async dev_clean({ ids, roots, permanent }) {
    const s = await rpc('scan_dev_cleaners', { roots: roots ?? null });
    const want = new Set(ids);
    const items = s.groups.flatMap((g) => g.items).filter((i) => want.has(i.id))
      .map((i) => ({ cleanerId: i.cleanerId, id: i.id, path: i.path, kind: i.kind, permanent: !!permanent }));
    if (!items.length) return 'None of those ids exist in a fresh scan.';
    const r = await rpc('clean_dev_items', { items });
    return [`cleaned ${r.cleaned.length}, failed ${r.failed.length}`, ...r.failed.map((f) => `  ${f.path}: ${f.error}`)].join('\n');
  },

  async relocatable({ toolId, targetRoot }) {
    if (!toolId) {
      const tools = await rpc('list_relocatable_tools', {});
      return tools.map((t) => `${t.id} | ${t.label} | ${t.exists ? t.source : 'not present'} | ${t.envVar}=${t.currentEnv ?? '(unset)'}`).join('\n');
    }
    if (!targetRoot) return 'targetRoot is required with toolId.';
    const p = await rpc('plan_relocation', { request: { toolId, targetRoot } });
    return [
      `${p.toolId}: ${(p.sourceBytes / 1073741824).toFixed(2)} GB  ${p.source} -> ${p.dest}`,
      ...p.steps.map((x) => `  - ${x}`),
      p.blockers.length ? `BLOCKED: ${p.blockers.join('; ')}` : 'Ready to relocate.',
    ].join('\n');
  },

  async relocate({ toolId, targetRoot }) {
    const r = await rpc('apply_relocation', { request: { toolId, targetRoot } });
    return `moved to ${r.dest}; ${r.envVar}=${r.envValue}
${r.note}`;
  },

  async sdk_install({ manager, version }) {
    return rpc('install_version_via_manager', { manager_name: manager, version });
  },

  async sdk_switch({ manager, version }) {
    return rpc('switch_version_via_manager', { manager_name: manager, version });
  },

  async sdks({ manager, available }) {
    const out = [];
    for (const m of manager ? [manager] : ['nvm', 'rustup', 'sdkman']) {
      try {
        const v = await rpc('get_manager_installed_versions', { manager_name: m });
        const cur = await rpc('get_manager_current_version', { manager_name: m }).catch(() => null);
        out.push(`${m}: ${v.length ? v.join(', ') : 'none installed'}${cur ? ` (active ${cur})` : ''}`);
        if (available && manager) out.push(`available: ${(await rpc('get_manager_available_versions', { manager_name: m })).slice(-30).join(', ')}`);
      } catch (e) {
        out.push(`${m}: unavailable (${e.message})`);
      }
    }
    return out.join('\n');
  },

  async db({ action = 'sources', source, table, sql, limit, offset }) {
    if (action === 'sources') {
      return (await rpc('db_list_sources')).map((x) => `${x.id} ${x.label} [${x.engine}] ${x.detail}`).join('\n') || 'No sources.';
    }
    if (!source) throw new Error('source is required (an id from db action "sources").');
    if (DB_SECRET.test(`${table ?? ''} ${sql ?? ''}`)) throw new Error('That touches credential or vault data, which db does not expose.');
    if (action === 'tables') {
      return lines(await rpc('db_list_tables', { source_id: source }), 200, (x) => `${x.name}${x.kind === 'table' ? '' : ` (${x.kind})`}`) || 'No tables.';
    }
    if ((action === 'describe' || action === 'rows') && !table) throw new Error(`table is required for ${action}.`);
    if (action === 'describe') {
      const cols = await rpc('db_describe_table', { source_id: source, table });
      return cols.map((c) => `${c.name} ${c.dataType}${c.pk ? ' pk' : ''}${c.notNull ? ' not null' : ''}${c.defaultValue != null ? ` default ${c.defaultValue}` : ''}`).join('\n') || `No columns for ${table}.`;
    }
    let r;
    if (action === 'rows') r = await rpc('db_fetch_rows', { source_id: source, table, limit: cap(limit), offset: Math.max(offset ?? 0, 0) });
    else if (action === 'query') {
      if (!sql) throw new Error('sql is required for query.');
      readOnlySql(sql);
      r = await rpc('db_run_query', { source_id: source, sql });
    } else throw new Error(`Unknown db action ${action}.`);
    const rows = r.rows.slice(0, 200);
    return clip([r.columns.join(' | '), ...rows.map((x) => x.map(cell).join(' | ')), `${rows.length} row(s)${r.truncated || r.rows.length > 200 ? ', truncated at 200' : ''}`].join('\n'));
  },

  async docs({ action = 'list', id, query, title, content, tags: tagList, archived }) {
    const row = (d) => `#${d.id} ${d.title}${tags(d).length ? ` [${tags(d).join(', ')}]` : ''}${d.is_archived ? ' (archived)' : ''} · ${ago(d.updated_at ?? d.created_at)}`;
    if (action === 'list') {
      const docs = query ? await rpc('search_documents', { query }) : await rpc('get_documents');
      docs.sort((a, b) => Date.parse(b.updated_at ?? 0) - Date.parse(a.updated_at ?? 0));
      return lines(docs, 100, row) || 'No documents.';
    }
    if (action === 'get') {
      if (!id) throw new Error('id is required for get.');
      const d = await rpc('get_document', { id });
      if (!d) throw new Error(`No document #${id}.`);
      return clip(`${row(d)}\n\n${d.content}`, 12000);
    }
    if (action === 'create') {
      if (!title || content === undefined) throw new Error('title and content are required for create.');
      return `Created ${row(await rpc('create_document', { command: { title, content, tags: tagList, is_archived: archived } }))}`;
    }
    if (action === 'update') {
      if (!id) throw new Error('id is required for update.');
      const command = { title, content, tags: tagList, is_archived: archived };
      if (Object.values(command).every((v) => v === undefined)) throw new Error('Nothing to change: pass title, content, tags or archived.');
      return `Updated ${row(await rpc('update_document', { id, command }))}`;
    }
    throw new Error(`Unknown docs action ${action}.`);
  },

  async k8s({ action = 'clusters', namespace, pod, container, tail: n, limit }) {
    const max = cap(limit);
    if (action === 'clusters') {
      const cur = await rpc('k8s_get_current_cluster').catch(() => null);
      const state = (c) => (typeof c.status === 'string' ? c.status : `error: ${c.status?.Error ?? '?'}`);
      return (
        lines(await rpc('k8s_load_clusters'), max, (c) => `${cur?.name === c.name ? '*' : ' '} ${c.name} (context ${c.context}, ns ${c.namespace}) ${state(c)}${c.version ? ` ${c.version}` : ''}`) ||
        'No clusters in the kubeconfig.'
      );
    }
    // The shared client is only set by Portal's own connect; never connect on the caller's behalf.
    if (!(await rpc('k8s_is_connected'))) {
      return 'No Kubernetes cluster is connected in Portal. Connect one on its Kubernetes page, then retry; this tool never connects. (action "clusters" lists what is available.)';
    }
    const ns = namespace || null;
    if (action === 'namespaces') return lines(await rpc('k8s_list_namespaces'), max, (x) => `${x.name} ${x.status} ${x.age}`) || 'None.';
    if (action === 'pods') {
      return lines(await rpc('k8s_list_pods', { namespace: ns }), max, (p) => `${p.namespace}/${p.name} ${p.status} ready ${p.ready} restarts ${p.restarts} ${p.age}`) || 'No pods.';
    }
    if (action === 'deployments') {
      const d = await rpc('k8s_list_deployments', { namespace: ns });
      return lines(d, max, (x) => `${x.namespace}/${x.name} ${x.available}/${x.desired} available, ${x.up_to_date} up to date ${x.age}`) || 'No deployments.';
    }
    if (action === 'events') {
      const ev = (await rpc('k8s_list_events', { namespace: ns })).sort((a, b) => Date.parse(b.last_timestamp ?? 0) - Date.parse(a.last_timestamp ?? 0));
      return lines(ev, max, (e) => `${ago(e.last_timestamp)} ${e.type_ ?? ''} ${e.reason} ${e.involved_object?.kind}/${e.involved_object?.name}${e.count > 1 ? ` x${e.count}` : ''}: ${String(e.message).slice(0, 200)}`) || 'No events.';
    }
    if (action === 'logs') {
      if (!namespace || !pod) throw new Error('namespace and pod are required for logs.');
      const k = Math.min(Math.max(n ?? 80, 1), 500);
      const raw = await rpc('k8s_get_pod_logs', { namespace, pod_name: pod, container: container ?? null, follow: false, tail_lines: k });
      return clip(tail(raw, k)) || 'No logs.';
    }
    throw new Error(`Unknown k8s action ${action}.`);
  },

  async create_project({ name, path, description }) {
    const dir = path || process.cwd();
    const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const same = (await rpc('get_all_projects')).find((p) => norm(p.path) === norm(dir));
    if (same) return `Already registered: ${same.id} ${same.name} — ${same.path}`;
    const p = await rpc('create_project', { name: name || dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop(), description, path: dir });
    return `Created project ${p.id} ${p.name} — ${p.path ?? dir}`;
  },

  async tasks({ project: ref, done, status, priority, type, assignee, search, overdue }) {
    const every = ref === '*';
    const p = every ? null : await project(ref);
    const names = every ? new Map((await rpc('get_all_projects')).map((x) => [String(x.id), x.name])) : null;
    const filters = every ? { resource_type: 'project' } : { resource_type: 'project', resource_id: String(p.id) };
    if (priority) filters.priority = [priority];
    if (type) filters.type_ = [type];
    let all = await rpc('get_tasks', { filters });
    if (overdue) {
      const late = new Set((await rpc('get_overdue_tasks')).map((t) => t.id));
      all = all.filter((t) => late.has(t.id));
    }
    const kids = new Map();
    for (const t of all) if (t.parent_id) kids.set(t.parent_id, [...(kids.get(t.parent_id) ?? []), t]);
    const rank = (t) => OPEN.indexOf(t.status) * 3 + PRIORITIES.indexOf(t.priority); // in-progress, then pending; high first
    const week = Date.now() - 7 * 86400000;
    const q = (search ?? '').toLowerCase();
    const match = (t) =>
      (!status || t.status === status) &&
      (!assignee || t.assignee === assignee) &&
      (!q || `${t.title} ${t.description ?? ''}`.toLowerCase().includes(q));
    const wantClosed = done || (status && !OPEN.includes(status));
    const shown = (t) => match(t) && (OPEN.includes(t.status) || (wantClosed && Date.parse(t.updated_at ?? t.created_at) > week));
    const top = all.filter((t) => !t.parent_id && shown(t)).sort((a, b) => rank(b) - rank(a));
    if (!top.length) return `${every ? 'Every project' : p.name}: board is clear${done ? '' : ' (no open tasks)'}.`;

    const out = [];
    const groups = every ? Map.groupBy(top, (t) => names.get(t.resource_id) ?? `project ${t.resource_id}`) : new Map([[p.name, top]]);
    for (const [name, list] of groups) {
      out.push(`## ${name}`);
      for (const t of list) {
        const children = kids.get(t.id) ?? [];
        const steps = children.filter((c) => !isNote(c));
        const last = children.filter(isNote).at(-1);
        let s = line(t);
        if (steps.length) s += ` · steps ${steps.filter((c) => c.status === 'completed').length}/${steps.length}`;
        if (last) s += `\n    last: ${last.assignee ? `${last.assignee}: ` : ''}${last.title} (${ago(last.created_at)})`;
        out.push(s);
      }
    }
    return out.join('\n');
  },

  async task({ id }) {
    const t = await rpc('get_task', { id });
    if (!t) throw new Error(`No task #${id}.`);
    const children = await rpc('get_subtasks', { parent_id: id });
    const steps = children.filter((c) => !isNote(c));
    const log = children.filter(isNote);
    return [
      line(t) + ` portal://task/${t.id}`,
      t.description ?? '',
      steps.length ? `\nSteps:\n${steps.map((c) => `  ${c.status === 'completed' ? '[x]' : '[ ]'} #${c.id} ${c.title}${c.assignee ? ` @${c.assignee}` : ''}`).join('\n')}` : '',
      log.length ? `\nLog:\n${log.map((c) => `  ${ago(c.created_at)} ${c.assignee ?? ''}: ${c.title}${c.description ? `\n    ${c.description}` : ''}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  },

  async add({ title, description, type = 'Task', priority = 'medium', status = 'pending', assignee, parent_id, project: ref, session_id }) {
    let link;
    const sessionTag = session_id ? [`session:${session_id}`] : [];
    if (parent_id) {
      const parent = await rpc('get_task', { id: parent_id });
      if (!parent) throw new Error(`No task #${parent_id} to add a step to.`);
      link = { resource_id: parent.resource_id, resource_type: parent.resource_type, tags: JSON.stringify([...tags(parent), ...sessionTag]) };
    } else {
      const p = await project(ref);
      link = { resource_id: String(p.id), resource_type: 'project', tags: JSON.stringify([p.name, ...sessionTag]) };
    }
    const t = await rpc('create_task', {
      command: { title, description, type_: type, priority, status, assignee, parent_id, ...link },
    });
    return `Added ${line(t)}`;
  },

  async update({ id, note, by, session_id, ...fields }) {
    const changed = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== ''));
    const current = await rpc('get_task', { id });
    if (!current) throw new Error(`No task #${id}.`);

    // The session tag only means anything while in-progress: it auto-clears
    // leaving that status, and only an explicit session_id touches it otherwise.
    const effectiveStatus = changed.status ?? current.status;
    const curTags = tags(current);
    let newTags = curTags;
    if (effectiveStatus !== 'in-progress') {
      newTags = curTags.filter((x) => !x.startsWith('session:'));
    } else if (session_id !== undefined) {
      newTags = [...curTags.filter((x) => !x.startsWith('session:')), ...(session_id ? [`session:${session_id}`] : [])];
    }
    if (newTags.length !== curTags.length || newTags.some((x, i) => x !== curTags[i])) {
      changed.tags = JSON.stringify(newTags);
    }

    const t = Object.keys(changed).length ? await rpc('update_task', { id, command: changed }) : current;
    if (note) {
      const text = note.trim();
      const overLong = Buffer.byteLength(text, 'utf8') > 200;
      await rpc('create_task', {
        command: {
          title: overLong ? truncateBytes(text, 200) : text,
          description: overLong ? truncateBytes(text, 1000, '') : undefined,
          type_: 'Subtask',
          status: 'completed',
          priority: 'low',
          assignee: by ?? t.assignee ?? 'claude',
          parent_id: id,
          resource_id: t.resource_id,
          resource_type: t.resource_type,
          tags: JSON.stringify([...tags(t).filter((x) => x !== 'note'), 'note']),
        },
      });
    }
    return `${line(t)}${note ? '\n  + note logged' : ''}`;
  },
};

// --- stdio JSON-RPC ---------------------------------------------------------

function serve() {
  const { version } = require('../.claude-plugin/plugin.json');
  const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  require('readline')
    .createInterface({ input: process.stdin })
    .on('line', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id === undefined) return; // notification
      const { id, method, params } = msg;
      if (method === 'initialize') {
        // Runs are tagged mcp:<client> so Portal shows who asked for them.
        clientName = String(params?.clientInfo?.name || 'mcp').replace(/[^\w.-]/g, '-');
        return send({
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'portal', version },
          },
        });
      }
      if (method === 'tools/list') return send({ id, result: { tools } });
      if (method === 'ping') return send({ id, result: {} });
      if (method !== 'tools/call') return send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
      const handler = handlers[params?.name];
      try {
        if (!handler) throw new Error(`Unknown tool ${params?.name}`);
        send({ id, result: { content: [{ type: 'text', text: await handler(params.arguments ?? {}) }] } });
      } catch (e) {
        send({ id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
      }
    });
}

function selftest() {
  const assert = require('assert');
  const all = [
    { id: 1, name: 'Portal Desktop', path: '/media/tan/Workspace/production/portal/portal_desktop' },
    { id: 15, name: 'agentic-ai', path: 'D:\\projects\\production\\ai\\agentic-ai' },
    { id: 19, name: 'plugins', path: 'D:\\projects\\production\\ai\\plugins' },
    { id: 65, name: 'ui', path: 'D:\\projects\\production\\flutter\\ui' },
  ];
  const id = (ref) => findProject(all, ref)?.id ?? null;
  assert.equal(id('19'), 19);
  assert.equal(id('PLUGINS'), 19);
  assert.equal(id('D:\\projects\\production\\ai\\plugins'), 19);
  assert.equal(id('d:/projects/production/ai/plugins/crew/mcp'), 19); // inside a project
  assert.equal(id('D:\\projects\\production\\ai\\agentic-ai\\agent-platform'), 15); // deepest registered parent
  assert.equal(id('D:\\projects\\production\\portal\\portal_desktop\\src-tauri'), 1); // other-OS path
  assert.equal(id('C:\\elsewhere\\ui'), null); // one shared segment is not a match
  assert.equal(id('C:\\Users\\tanvo'), null);
  assert.equal(terminalText('a\n10%\r100%\n\x1b[32mok\x1b[0m\r\n'), 'a\n100%\nok\n');
  assert.equal(failureNote({ status: 'failed', error: 'Working directory does not exist: X\n' }, ''), '\n--- error ---\nWorking directory does not exist: X');
  assert.equal(failureNote({ status: 'failed', error: 'Exit code 1\nboom' }, 'boom'), ''); // the output already says it
  assert.equal(failureNote({ status: 'success' }, ''), '');
  for (const ok of ['select 1', ' SELECT * FROM t; ', 'with a as (select 1) select * from a', "select ';' as x -- drop table t", 'select "update" from t'])
    assert.doesNotThrow(() => readOnlySql(ok), ok);
  for (const bad of ['delete from t', 'select 1; drop table t', 'with a as (delete from t returning 1) select * from a', 'pragma writable_schema=1', 'select * into x from t', '/* hi */ update t set a=1'])
    assert.throws(() => readOnlySql(bad), bad);
  console.log('portal.js selftest ok');
}

if (process.argv.includes('--selftest')) selftest();
else serve();
