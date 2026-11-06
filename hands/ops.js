#!/usr/bin/env node
// Detects how this project starts, and stops what it started.
//
// It never launches anything itself -- launching stays with the Bash tool so
// the run is backgrounded and its logs stream. This file only answers "what is
// the command" and "what is holding that port".
//
// Usage:
//   node ops.js detect [dir]     how this app starts, cached to .claude/launch.json
//   node ops.js scan             every runnable app in the workspace
//   node ops.js procs            every port listening on this machine
//   node ops.js down [port]      kill what listens there (--all for the whole workspace)
//   node ops.js wait <port>      block until the port answers
//   node ops.js selftest         assert the detection table

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WIN = process.platform === 'win32';

// ---------------------------------------------------------------- detection

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const json = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
const has = (dir, ...rel) => rel.some((r) => fs.existsSync(path.join(dir, r)));
const glob1 = (dir, re) => {
  try { return fs.readdirSync(dir).find((f) => re.test(f)) || null; } catch { return null; }
};

function packageManager(dir) {
  if (has(dir, 'bun.lockb', 'bun.lock')) return 'bun';
  if (has(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(dir, 'yarn.lock')) return 'yarn';
  return 'npm';
}

// ------------------------------------------------------------------- ports
// A stack's default port is a guess, and the guess is wrong for any repo that
// moved off it. Four sources, most explicit first: the flag in the dev script,
// the framework's own config, an env file, then the default.

// Loaded in override order, so the first hit wins the same way the tooling
// resolves them.
const ENV_FILES = ['.env.development.local', '.env.local', '.env.development', '.env'];

function envPort(dir) {
  for (const f of ENV_FILES) {
    const src = read(path.join(dir, f));
    const m = src && src.match(/^\s*(?:export\s+)?(?:PORT|APP_PORT|SERVER_PORT)\s*=\s*["']?(\d{2,5})["']?/m);
    if (m) return Number(m[1]);
  }
  return null;
}

// `next dev -p 3001`, `vite --port 5174`. The most explicit signal there is:
// someone typed this port on purpose.
function scriptPort(pkg) {
  const s = pkg && pkg.scripts && pkg.scripts.dev;
  const m = s && s.match(/(?:--port[= ]|(?:^|\s)-p\s+)(\d{2,5})/);
  return m ? Number(m[1]) : null;
}

// Scoped to the `server` block so an `hmr: { port }` next door is not mistaken
// for the dev server's own.
function configPort(dir, file) {
  const src = file && read(path.join(dir, file));
  const m = src && src.match(/server\s*:\s*\{[\s\S]{0,400}?port\s*:\s*(\d{2,5})/);
  return m ? Number(m[1]) : null;
}

// A uv or poetry project has its dependencies inside a managed environment, so
// a bare `uvicorn` resolves to the wrong interpreter or to nothing at all.
function pyRunner(dir) {
  if (has(dir, 'uv.lock')) return 'uv run ';
  if (has(dir, 'poetry.lock')) return 'poetry run ';
  return '';
}

// Tauri keeps the frontend dev server URL in its own config, and that is the
// port worth knowing -- the webview itself is not listening on anything. The
// URL is already written out there, so take it whole rather than rebuilding it.
function tauriDev(dir) {
  const conf = json(path.join(dir, 'src-tauri', 'tauri.conf.json'));
  const url = conf && conf.build && (conf.build.devUrl || conf.build.devPath);
  const m = typeof url === 'string' && url.match(/^https?:\/\/[^\s/]+?:(\d{2,5})/);
  return m ? { port: Number(m[1]), url: m[0] } : { port: 1420, url: null };
}

// A dev server on TLS answers on the same port but rejects http://, so the
// scheme has to travel with the port or /shot opens a page that never loads.
// Read the value rather than looking ahead for `false`: a negative lookahead
// after `\s*` just backtracks onto the whitespace and matches anyway.
function viteHttps(dir, file) {
  const src = file && read(path.join(dir, file));
  const m = src && src.match(/server\s*:\s*\{[\s\S]{0,400}?https\s*:\s*([^,}\s]+)/);
  return !!m && m[1] !== 'false';
}

// Directories that either cannot hold this project's own app module or would
// make the walk unbounded. site-packages is the important one: FastAPI's own
// source lives there, and matching it would point uvicorn at the library.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'env', '__pycache__', 'site-packages',
  'dist', 'build', 'target', '.next', '.mypy_cache', '.pytest_cache', '.tox',
  'migrations', 'tests', 'test', '.idea', '.vscode',
]);

// The uvicorn target is a module path, not a file path, so the app has to be
// found by content. A fixed list of filenames only covers the layouts someone
// thought of; walking finds the rest.
function pyFiles(dir, maxDepth = 4) {
  const out = [];
  const walk = (cur, depth, rel) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(path.join(cur, e.name), depth + 1, rel.concat(e.name));
      } else if (e.name.endsWith('.py')) {
        out.push({ parts: rel.concat(e.name), depth });
      }
    }
  };
  walk(dir, 0, []);
  return out;
}

// Rank rather than take the first hit: two files can both build a FastAPI app
// (a sub-router module and the real entrypoint), and the shallower, more
// conventionally named one is the entrypoint essentially every time.
function pyRank({ parts, depth }) {
  const base = parts[parts.length - 1];
  const name = base === 'main.py' ? 0 : base === 'app.py' ? 1 : base === 'server.py' ? 2 : 3;
  return depth * 10 + name;
}

function fastapiTarget(dir) {
  const hits = [];
  for (const f of pyFiles(dir)) {
    const src = read(path.join(dir, ...f.parts));
    // Require an assignment, not a bare mention: `from fastapi import FastAPI`
    // and `def make_app() -> FastAPI(...)` are not uvicorn targets.
    const m = src && src.match(/^\s*(\w+)\s*(?::[^=\n]+)?=\s*FastAPI\s*\(/m);
    if (m) hits.push({ ...f, varName: m[1] });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => pyRank(a) - pyRank(b));
  const best = hits[0];
  const mod = best.parts.join('.').replace(/\.py$/, '');
  return `${mod}:${best.varName}`;
}

// Ordered: the first rule that matches wins. Tauri outranks Next because a
// Tauri app has a Next frontend inside it and `npm run dev` would start half
// the application. Compose is last for the mirror reason -- a repo with both a
// compose file and a dev server usually wants the dev server.
function detect(dir) {
  const pkg = json(path.join(dir, 'package.json'));
  const pm = packageManager(dir);
  const runner = `${pm} run`;

  if (has(dir, 'src-tauri/tauri.conf.json')) {
    const t = tauriDev(dir);
    return { stack: 'tauri', command: `${runner} tauri dev`, port: t.port, url: t.url };
  }
  const nextCfg = glob1(dir, /^next\.config\./);
  if (nextCfg) {
    // Next reads PORT from the environment itself, so an env file is a real
    // override here rather than something we have to pass on the command line.
    return { stack: 'nextjs', command: `${runner} dev`, port: scriptPort(pkg) ?? envPort(dir) ?? 3000 };
  }
  const viteCfg = glob1(dir, /^vite\.config\./);
  if (viteCfg) {
    // Vite ignores PORT, so its own config outranks any env file.
    const port = scriptPort(pkg) ?? configPort(dir, viteCfg) ?? 5173;
    const url = viteHttps(dir, viteCfg) ? `https://localhost:${port}` : null;
    return { stack: 'vite', command: `${runner} dev`, port, url };
  }
  if (has(dir, 'manage.py')) {
    // Neither runserver nor uvicorn reads PORT, so a port found in an env file
    // has to be passed explicitly or the report would not match reality.
    const port = envPort(dir) ?? 8000;
    const arg = port === 8000 ? '' : ` ${port}`;
    return { stack: 'django', command: `${pyRunner(dir)}python manage.py runserver${arg}`, port };
  }
  // Gate the walk on the repo being Python at all, so a Node repo never pays
  // for it. Any of these four is enough to make the scan worth doing.
  const isPython = has(dir, 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile');
  const fastapi = isPython ? fastapiTarget(dir) : null;
  if (fastapi) {
    const port = envPort(dir) ?? 8000;
    const arg = port === 8000 ? '' : ` --port ${port}`;
    return { stack: 'fastapi', command: `${pyRunner(dir)}uvicorn ${fastapi} --reload${arg}`, port };
  }
  if (pkg && pkg.scripts && pkg.scripts.dev) {
    return { stack: 'node', command: `${runner} dev`, port: scriptPort(pkg) ?? envPort(dir) ?? null };
  }
  if (has(dir, 'Cargo.toml')) {
    return { stack: 'rust', command: 'cargo run', port: null };
  }
  if (has(dir, 'go.mod')) {
    return { stack: 'go', command: 'go run .', port: null };
  }
  if (has(dir, 'docker-compose.yml', 'compose.yaml', 'docker-compose.yaml')) {
    return { stack: 'compose', command: 'docker compose up', port: null };
  }
  return null;
}

// --------------------------------------------------------------- monorepo

// Where a workspace's apps conventionally live. Scanning the whole tree would
// find vendored examples and fixtures too, so this stays a short list.
const WORKSPACE_DIRS = ['apps', 'packages', 'services', 'crates', 'examples'];

// Root wins when it detects: a turborepo's own `turbo run dev` at the root is
// usually what you want, and only when the root says nothing is it worth
// asking which app.
function scan(root) {
  const found = [];
  const consider = (dir) => {
    const d = detect(dir);
    if (d) found.push({ ...d, dir, name: rel(root, dir) });
  };
  for (const group of WORKSPACE_DIRS) {
    const base = path.join(root, group);
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        consider(path.join(base, e.name));
      }
    }
  }
  return found;
}

// ------------------------------------------------------------------- cache
// .claude/launch.json is the harness's own format, so what is cached here is
// also what `preview_start` reads. One file, two readers.
//
// It lives at the repo root even for a workspace app, so one file holds every
// app in a monorepo -- which is also what the harness expects, since it looks
// for launch.json at the root.

const launchPath = (root) => path.join(root, '.claude', 'launch.json');
const rel = (root, dir) => path.relative(root, dir).split(path.sep).join('/');

function repoRoot(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(dir);
    cur = up;
  }
}

// A workspace app is named for its path, so two Next apps in one repo do not
// collide on the stack name.
const configName = (root, dir, stack) => (path.resolve(dir) === root ? stack : rel(root, dir));

// `/shot` only needs to know whether to point a browser at this or capture a
// desktop window. Deriving that from the command means the cache keeps working
// without adding a field to the harness's launch.json schema -- a workspace
// entry is named for its path, so its name cannot carry the stack.
function kindOf(command, stack) {
  if (stack) return ['tauri', 'rust', 'go'].includes(stack) ? 'native' : 'web';
  if (/\btauri\b/.test(command)) return 'native';
  if (/^(cargo|go)\b/.test(command)) return 'native';
  return 'web';
}

function load(root, name, dir) {
  const f = json(launchPath(root));
  const list = (f && Array.isArray(f.configurations) && f.configurations) || [];
  const c = name ? list.find((x) => x.name === name) : list[0];
  if (!c) return null;
  const command = [c.runtimeExecutable, ...(c.runtimeArgs || [])].join(' ');
  // launch.json is shared with the harness, so an entry here may have been
  // written by hand or by another tool rather than cached by us. One case is
  // worth re-deriving: a repo with src-tauri whose entry does not run tauri.
  // `pnpm dev` there starts the frontend and leaves the application unbuilt,
  // and the entry reports `web`, so /shot points a browser at half the app.
  // This is the same rule detection already applies - tauri outranks the
  // frontend config it contains - held to on the way back out of the cache.
  if (dir && has(dir, 'src-tauri/tauri.conf.json') && !/\btauri\b/.test(command)) return null;
  return {
    stack: c.name, kind: kindOf(command, null), command,
    port: c.port ?? null, url: c.url ?? null, cached: true,
  };
}

function save(root, name, d) {
  const [exe, ...args] = d.command.split(' ');
  const conf = { name, runtimeExecutable: exe, runtimeArgs: args };
  if (d.port) conf.port = d.port;
  // `url` is part of the harness's own launch.json schema, so a TLS dev server
  // is opened correctly by `preview_start` too, not just by /shot.
  if (d.url) conf.url = d.url;
  const existing = json(launchPath(root)) || { version: '0.0.1', configurations: [] };
  const others = (existing.configurations || []).filter((c) => c.name !== name);
  existing.configurations = [conf, ...others];
  fs.mkdirSync(path.dirname(launchPath(root)), { recursive: true });
  fs.writeFileSync(launchPath(root), JSON.stringify(existing, null, 2) + '\n');
}

// -------------------------------------------------------------------- kill

// PIDs that are the operating system, not a dev server. Killing 4 on Windows
// bluescreens the machine, so this is a hard floor rather than a warning.
const SYSTEM_PIDS = new Set([0, 4]);

// One listing, filtered two ways: `down` wants a single port, `procs` wants all
// of them. Keeping it as one source means they cannot disagree about what is
// running.
function allListeners() {
  const seen = new Map(); // "port:pid" -> {port, pid, name}
  const add = (port, pid, name) => {
    if (!(port > 0) || !(pid > 0) || SYSTEM_PIDS.has(pid)) return;
    const key = `${port}:${pid}`;
    if (!seen.has(key)) seen.set(key, { port, pid, name: name || null });
  };
  if (WIN) {
    let out = '';
    try { out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }); } catch { return []; }
    for (const line of out.split('\n')) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      // Split on the last colon: an IPv6 local address is full of them.
      const local = cols[1] || '';
      add(Number(local.slice(local.lastIndexOf(':') + 1)), Number(cols[cols.length - 1]));
    }
  } else {
    let out = '';
    try {
      out = execFileSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], { encoding: 'utf8' });
    } catch { return []; }
    for (const line of out.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      const addr = cols[cols.length - 1] || '';
      add(Number(addr.slice(addr.lastIndexOf(':') + 1)), Number(cols[1]), cols[0]);
    }
  }
  return [...seen.values()];
}

const listeners = (port) => [...new Set(allListeners().filter((l) => l.port === port).map((l) => l.pid))];

// A published container port belongs to the Docker daemon, so every one of them
// reports the same pid and a name like `com.docker.backend`. Without this,
// `procs` says four things are running and cannot tell you which.
function dockerPorts() {
  const map = new Map();
  let out = '';
  try {
    out = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return map; } // no docker, or the daemon is down -- not an error here
  for (const line of out.split('\n')) {
    const [name, ports] = line.split('\t');
    if (!name || !ports) continue;
    for (const m of ports.matchAll(/:(\d{2,5})->/g)) map.set(Number(m[1]), name);
  }
  return map;
}

function describe(pid) {
  try {
    if (WIN) {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      return (out.match(/^"([^"]+)"/) || [])[1] || 'unknown';
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim() || 'unknown';
  } catch { return 'gone'; }
}

// The tree kill matters for Tauri: cargo spawns the app binary as a child, and
// killing only the listener leaves the webview alive to fight the next start.
function killTree(pid) {
  try {
    if (WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); } }
    return true;
  } catch { return false; }
}

function downPort(port, force) {
  if (port < 1024 && !force) {
    console.log(`refusing port ${port}: privileged. re-run with --force if you meant it`);
    return 1;
  }
  const pids = listeners(port);
  if (!pids.length) {
    console.log(`port ${port}: nothing listening`);
    return 0;
  }
  for (const pid of pids) {
    const name = describe(pid);
    console.log(`port ${port}: ${killTree(pid) ? 'killed' : 'FAILED to kill'} ${pid} (${name})`);
  }
  return 0;
}

function down(dir, portArg, force, all) {
  const root = repoRoot(dir);

  // --all takes every port this workspace has ever cached, which is the only
  // way to clear a monorepo where the apps were started one at a time.
  if (all) {
    const f = json(launchPath(root));
    const ports = [...new Set(((f && f.configurations) || []).map((c) => c.port).filter(Boolean))];
    if (!ports.length) {
      console.log('nothing cached: run `detect` in each app first, or pass a port');
      return 1;
    }
    return ports.map((p) => downPort(p, force)).some((c) => c !== 0) ? 1 : 0;
  }

  const port = portArg ?? (load(root, configName(root, dir, null)) || load(root) || detect(dir) || {}).port;
  if (!port) {
    console.log('no port: pass one explicitly, or run `detect` first');
    return 1;
  }
  return downPort(port, force);
}

// -------------------------------------------------------------------- wait

// "Started" should mean the port answers, not that a process was spawned. A
// dev server that dies on a syntax error still spawns.
function waitForPort(port, timeoutMs) {
  const net = require('net');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      const retry = () => {
        sock.destroy();
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(attempt, 250);
      };
      sock.setTimeout(1000);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('timeout', retry);
      sock.once('error', retry);
    };
    attempt();
  });
}

// ---------------------------------------------------------------- selftest

function selftest() {
  const assert = require('assert');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-'));
  const mk = (name, files) => {
    const d = path.join(tmp, name);
    for (const [rel, body] of Object.entries(files)) {
      const f = path.join(d, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    }
    return d;
  };

  // Tauri wins over the Next frontend it contains, and takes its port from
  // tauri.conf.json rather than the 1420 default.
  const tauri = mk('tauri', {
    'next.config.js': '',
    'package.json': '{"scripts":{"dev":"next dev"}}',
    'src-tauri/tauri.conf.json': '{"build":{"devUrl":"http://localhost:3007"}}',
  });
  assert.deepStrictEqual(detect(tauri),
    { stack: 'tauri', command: 'npm run tauri dev', port: 3007, url: 'http://localhost:3007' });

  // Lockfile picks the runner.
  const next = mk('next', { 'next.config.mjs': '', 'pnpm-lock.yaml': '', 'package.json': '{}' });
  assert.deepStrictEqual(detect(next), { stack: 'nextjs', command: 'pnpm run dev', port: 3000 });

  // A TLS dev server answers on the same port but rejects http://, so the
  // scheme has to survive into the cache or /shot opens a page that never loads.
  const tls = mk('tls', {
    'vite.config.ts': 'export default { server: { https: {}, port: 5174 } }',
    'package.json': '{}',
  });
  assert.strictEqual(detect(tls).url, 'https://localhost:5174');
  save(tls, 'vite', detect(tls));
  assert.strictEqual(load(tls, 'vite').url, 'https://localhost:5174');

  // `https: false` is the common way to turn it back off, and must not read as
  // enabled just because the key is present.
  const noTls = mk('notls', {
    'vite.config.ts': 'export default { server: { https: false, port: 5174 } }',
    'package.json': '{}',
  });
  assert.strictEqual(detect(noTls).url, null);

  // Port sources, most explicit first. The flag someone typed into the dev
  // script beats an env file.
  const flag = mk('flag', {
    'next.config.js': '',
    'package.json': '{"scripts":{"dev":"next dev -p 3001"}}',
    '.env': 'PORT=9999\n',
  });
  assert.strictEqual(detect(flag).port, 3001);

  // With no flag, the env file beats the 3000 default -- Next reads PORT itself.
  const envd = mk('envd', { 'next.config.js': '', 'package.json': '{}', '.env': 'PORT="4100"\n' });
  assert.strictEqual(detect(envd).port, 4100);

  // .env.local overrides .env, same as the tooling resolves them.
  const layered = mk('layered', {
    'next.config.js': '', 'package.json': '{}',
    '.env': 'PORT=4100\n', '.env.local': 'PORT=4200\n',
  });
  assert.strictEqual(detect(layered).port, 4200);

  // Vite ignores PORT, so its own config outranks the env file.
  const vite = mk('vite', {
    'vite.config.ts': 'export default { server: { host: true, port: 5174 }, hmr: { port: 24678 } }',
    'package.json': '{}',
    '.env': 'PORT=9999\n',
  });
  assert.strictEqual(detect(vite).port, 5174);

  // uvicorn does not read PORT, so a non-default port must reach the command
  // line or the reported port would not be the one it listens on.
  const apiPort = mk('apiport', { 'pyproject.toml': '', 'main.py': 'app = FastAPI()', '.env': 'PORT=8080\n' });
  assert.deepStrictEqual(detect(apiPort), {
    stack: 'fastapi', command: 'uvicorn main:app --reload --port 8080', port: 8080,
  });

  const dj = mk('dj', { 'manage.py': '', '.env': 'PORT=8001\n' });
  assert.strictEqual(detect(dj).command, 'python manage.py runserver 8001');

  // FastAPI target is found by content, and keeps the app's real variable name.
  const api = mk('api', { 'pyproject.toml': '', 'app/main.py': 'api = FastAPI()\n' });
  assert.deepStrictEqual(detect(api), { stack: 'fastapi', command: 'uvicorn app.main:api --reload', port: 8000 });

  // Found at an unconventional depth no fixed filename list would cover, and
  // an annotated assignment still parses.
  const deep = mk('deep', {
    'requirements.txt': '',
    'services/gateway/src/entrypoint.py': 'app: FastAPI = FastAPI()\n',
  });
  assert.deepStrictEqual(detect(deep), {
    stack: 'fastapi',
    command: 'uvicorn services.gateway.src.entrypoint:app --reload',
    port: 8000,
  });

  // Two apps: the shallow, conventionally named one is the entrypoint.
  const two = mk('two', {
    'pyproject.toml': '',
    'main.py': 'app = FastAPI()\n',
    'app/routers/sub.py': 'sub = FastAPI()\n',
  });
  assert.strictEqual(detect(two).command, 'uvicorn main:app --reload');

  // uv and poetry projects need their managed interpreter.
  const uv = mk('uv', { 'pyproject.toml': '', 'uv.lock': '', 'main.py': 'app = FastAPI()\n' });
  assert.strictEqual(detect(uv).command, 'uv run uvicorn main:app --reload');

  // An import is not an app, and a vendored copy of FastAPI's own source in a
  // skipped directory must not be picked up as the target.
  const noApp = mk('noapp', {
    'pyproject.toml': '',
    'main.py': 'from fastapi import FastAPI\n',
    '.venv/lib/site-packages/fastapi/x.py': 'app = FastAPI()\n',
  });
  assert.strictEqual(detect(noApp), null);

  // A pyproject with no FastAPI app must not be reported as one.
  assert.strictEqual(detect(mk('plain', { 'pyproject.toml': '' })), null);

  // Round-trips through the harness's own launch.json format.
  const rt = mk('rt', { 'next.config.js': '', 'package.json': '{}' });
  save(rt, 'nextjs', detect(rt));
  assert.deepStrictEqual(load(rt, 'nextjs'),
    { stack: 'nextjs', kind: 'web', command: 'npm run dev', port: 3000, url: null, cached: true });

  // A cached workspace entry is named for its path, so kind must come from the
  // command -- this is what tells /shot to capture a window, not a browser tab.
  assert.strictEqual(kindOf('npm run tauri dev', null), 'native');
  assert.strictEqual(kindOf('cargo run', null), 'native');
  assert.strictEqual(kindOf('uv run uvicorn main:app --reload', null), 'web');
  assert.strictEqual(kindOf('npm run dev', null), 'web');

  // launch.json is shared with the harness, so a cached entry may be someone
  // else's. One that runs the frontend of a tauri repo is refused rather than
  // trusted: it starts half the application and reports the wrong surface.
  const foreign = mk('foreign', {
    'src-tauri/tauri.conf.json': '{}',
    'package.json': '{"scripts":{"dev":"vite"}}',
    '.claude/launch.json': JSON.stringify({
      version: '0.0.1',
      configurations: [{ name: 'web', runtimeExecutable: 'pnpm', runtimeArgs: ['dev'], port: 1420 }],
    }),
  });
  assert.strictEqual(load(foreign, null, foreign), null, 'a non-tauri entry in a tauri repo is not trusted');
  assert.strictEqual(load(foreign, null).stack, 'web', 'without a dir there is nothing to check it against');
  assert.strictEqual(detect(foreign).stack, 'tauri', 'detection then finds the real stack');

  // A monorepo whose root is not itself runnable: both apps are found, and
  // each is named for its path so two Next apps cannot collide in the cache.
  const mono = mk('mono', {
    '.git/HEAD': '',
    'pnpm-workspace.yaml': '',
    'apps/web/next.config.js': '',
    'apps/web/package.json': '{}',
    'apps/api/pyproject.toml': '',
    'apps/api/main.py': 'app = FastAPI()\n',
  });
  const apps = scan(mono).map((a) => `${a.name}:${a.stack}`).sort();
  assert.deepStrictEqual(apps, ['apps/api:fastapi', 'apps/web:nextjs']);
  assert.strictEqual(configName(mono, path.join(mono, 'apps/web'), 'nextjs'), 'apps/web');
  assert.strictEqual(configName(mono, mono, 'nextjs'), 'nextjs');
  assert.strictEqual(repoRoot(path.join(mono, 'apps/web')), mono);

  // Root wins when it is runnable -- a turborepo's own dev script beats
  // picking one of its apps.
  const turbo = mk('turbo', {
    '.git/HEAD': '',
    'package.json': '{"scripts":{"dev":"turbo run dev"}}',
    'apps/web/next.config.js': '',
    'apps/web/package.json': '{}',
  });
  assert.strictEqual(detect(turbo).stack, 'node');

  // Every cached port in the workspace is a --all target, deduplicated so a
  // shared port is not killed twice.
  const many = mk('many', { '.git/HEAD': '' });
  save(many, 'apps/web', { command: 'npm run dev', port: 3000 });
  save(many, 'apps/api', { command: 'uvicorn main:app', port: 8000 });
  save(many, 'apps/dup', { command: 'npm run dev', port: 3000 });
  const cached = json(launchPath(many)).configurations.map((c) => c.port);
  assert.deepStrictEqual([...new Set(cached)].sort(), [3000, 8000]);

  // Ports are read off the end of the address, so an IPv6 local address --
  // which is nothing but colons -- still yields the right one, and :3000 never
  // matches :13000.
  const lastPort = (addr) => Number(addr.slice(addr.lastIndexOf(':') + 1));
  assert.strictEqual(lastPort('127.0.0.1:13000'), 13000);
  assert.strictEqual(lastPort('[::]:3000'), 3000);
  assert.strictEqual(lastPort('[fe80::1%eth0]:8080'), 8080);

  // Docker publishes as `0.0.0.0:5432->5432/tcp`; only the host side is ours.
  const dockerLine = '0.0.0.0:5432->5432/tcp, :::15432->5432/tcp';
  assert.deepStrictEqual([...dockerLine.matchAll(/:(\d{2,5})->/g)].map((m) => Number(m[1])), [5432, 15432]);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('selftest ok');
  return 0;
}

// ------------------------------------------------------------------- entry

const argv = process.argv.slice(2);
const [cmd] = argv;
const positional = argv.slice(1).find((a) => !a.startsWith('--'));
const dir = process.cwd();
const root = repoRoot(dir);

if (cmd === 'detect') {
  const target = positional ? path.resolve(dir, positional) : dir;
  const name = configName(root, target, null);
  const cached = argv.includes('--fresh') ? null : load(root, name, target);
  let d = cached || detect(target);

  // Only ask which app when the root itself is not runnable. A repo that has
  // both a root dev script and workspace apps almost always wants the root.
  if (!d && path.resolve(target) === root) {
    const apps = scan(root);
    if (apps.length === 1) d = apps[0];
    else if (apps.length > 1) {
      console.log(JSON.stringify({ ambiguous: apps.map((a) => ({ name: a.name, stack: a.stack, port: a.port })) }));
      process.exit(2);
    }
  }
  if (!d) {
    console.log('no known stack here. add .claude/launch.json by hand and rerun.');
    process.exit(1);
  }
  if (!cached) save(root, configName(root, d.dir || target, d.stack), d);
  console.log(JSON.stringify({
    ...d,
    dir: undefined,
    kind: d.kind || kindOf(d.command, d.stack),
    url: d.url || (d.port ? `http://localhost:${d.port}` : null),
    cwd: rel(root, d.dir || target) || '.',
  }));
} else if (cmd === 'procs') {
  const docker = dockerPorts();
  const rows = allListeners()
    .filter((l) => l.port >= 1024)
    .map((l) => ({ port: l.port, pid: l.pid, name: docker.get(l.port) ? `docker:${docker.get(l.port)}` : (l.name || describe(l.pid)) }))
    .sort((a, b) => a.port - b.port);
  for (const r of rows) {
    console.log(String(r.port).padStart(6), String(r.pid).padStart(7), r.name);
  }
  if (!rows.length) console.log('nothing listening above 1024');
} else if (cmd === 'scan') {
  const apps = [detect(root) && { ...detect(root), dir: root, name: '.' }, ...scan(root)].filter(Boolean);
  console.log(JSON.stringify(apps.map((a) => ({ name: a.name, stack: a.stack, command: a.command, port: a.port }))));
} else if (cmd === 'down') {
  process.exit(down(dir, positional ? Number(positional) : undefined,
    argv.includes('--force'), argv.includes('--all')));
} else if (cmd === 'wait') {
  const port = Number(positional);
  const secs = Number((argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1]) || 45;
  if (!port) { console.log('usage: ops.js wait <port> [--timeout=45]'); process.exit(1); }
  waitForPort(port, secs * 1000).then((ok) => {
    console.log(ok ? `port ${port}: up` : `port ${port}: still not answering after ${secs}s`);
    process.exit(ok ? 0 : 1);
  });
} else if (cmd === 'selftest') {
  process.exit(selftest());
} else {
  console.log('usage: ops.js detect [dir] | scan | procs | down [port|--all] | wait <port> | selftest');
  process.exit(1);
}
