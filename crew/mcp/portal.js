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
  return `${head}\nrun ${id} · ${run.command}\nIn Portal: Action Runs → /pipeline-runs/${id}${out ?`\n--- output (tail) ---\n${out}` : ''}`;
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
  console.log('portal.js selftest ok');
}

if (process.argv.includes('--selftest')) selftest();
else serve();
