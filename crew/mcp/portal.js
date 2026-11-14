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

const BASE = process.env.PORTAL_URL || 'http://127.0.0.1:18420';
const STATUSES = ['pending', 'in-progress', 'completed', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high'];
const TYPES = ['Task', 'Bug', 'Story', 'Feature', 'Epic', 'Subtask'];
const OPEN = ['pending', 'in-progress'];

async function rpc(command, args = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/rpc/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error(`Portal is not running (nothing answers at ${BASE}). Start Portal, then retry.`);
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
      properties: { query: { type: 'string', description: 'Substring of name or path.' } },
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
];

const handlers = {
  async projects({ query }) {
    const all = await rpc('get_all_projects');
    const q = (query ?? '').toLowerCase();
    const hits = all.filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
    const shown = hits.slice(0, 50).map((p) => `${p.id} ${p.name} — ${p.path}`);
    return [...shown, hits.length > 50 ? `…${hits.length - 50} more; narrow with query.` : ''].join('\n').trim() || 'No projects match.';
  },

  async tasks({ project: ref, done }) {
    const every = ref === '*';
    const p = every ? null : await project(ref);
    const names = every ? new Map((await rpc('get_all_projects')).map((x) => [String(x.id), x.name])) : null;
    const filters = every ? { resource_type: 'project' } : { resource_type: 'project', resource_id: String(p.id) };
    const all = await rpc('get_tasks', { filters });
    const kids = new Map();
    for (const t of all) if (t.parent_id) kids.set(t.parent_id, [...(kids.get(t.parent_id) ?? []), t]);
    const rank = (t) => OPEN.indexOf(t.status) * 3 + PRIORITIES.indexOf(t.priority); // in-progress, then pending; high first
    const week = Date.now() - 7 * 86400000;
    const shown = (t) => OPEN.includes(t.status) || (done && Date.parse(t.updated_at ?? t.created_at) > week);
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
      line(t),
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
      await rpc('create_task', {
        command: {
          title: text.length > 200 ? `${text.slice(0, 198)}…` : text,
          description: text.length > 200 ? text.slice(0, 1000) : undefined,
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
  console.log('portal.js selftest ok');
}

if (process.argv.includes('--selftest')) selftest();
else serve();
