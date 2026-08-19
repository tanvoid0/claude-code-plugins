#!/usr/bin/env node
// PreToolUse gate. Tallies output tokens off the session transcript and, when
// the session is spending too much or too fast, warns the model or stops it.
//
// Runs before every tool call, so it must be fast and it must never throw:
// any failure exits 0 with no output and the tool call proceeds untouched.
//
// Reads state incrementally (byte offset per session) — a long transcript is
// parsed once, not once per tool call.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  enabled: true,
  // Budget is in OUTPUT tokens: they drive cost and they are what a runaway
  // loop actually burns. Cache reads are ~0.1x and are ignored on purpose.
  budget: 200000,
  // The model may raise `budget` mid-session (config edits are never blocked),
  // but never past `ceiling` — that one is the user's, from ~/.claude only.
  ceiling: 350000,
  softRatio: 0.6,        // warn once at 60% of budget
  hardRatio: 1.0,        // deny tool calls at 100%
  burnTokens: 25000,     // ...or if this many output tokens land
  burnMinutes: 5,        // ...inside this window
  rewarnMinutes: 10,     // floor between repeated warnings
};

const STATE_DIR = path.join(os.tmpdir(), 'claude-governor');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function userConfig(home) {
  return path.join(home, '.claude', 'governor.json');
}

function loadConfig(cwd, home = os.homedir()) {
  // Project config wins over user config wins over defaults. A missing or
  // malformed file is not an error — it just means defaults.
  const cfg = { ...DEFAULTS };
  let ceiling = DEFAULTS.ceiling;
  const user = userConfig(home);
  const candidates = [user, cwd ? path.join(cwd, '.claude', 'governor.json') : null];
  for (const file of candidates) {
    if (!file) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.assign(cfg, raw);
      // Only the user file sets the ceiling. A project file — or the model
      // editing one mid-session — cannot lift its own hard stop.
      if (file === user && typeof raw.ceiling === 'number') ceiling = raw.ceiling;
    } catch { /* absent or unparseable: keep what we have */ }
  }
  cfg.ceiling = ceiling;
  cfg.budget = Math.min(cfg.budget, ceiling);
  return cfg;
}

function loadState(sessionId) {
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, sessionId + '.json'), 'utf8');
    const s = JSON.parse(raw);
    if (typeof s.offset === 'number' && typeof s.output === 'number') return s;
  } catch { /* first call this session */ }
  return { offset: 0, output: 0, window: [], seen: [], softWarnedAt: 0, burnWarnedAt: 0 };
}

function saveState(sessionId, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, sessionId + '.json'), JSON.stringify(state));
  } catch { /* a lost tally is better than a broken tool call */ }
}

// Reads whatever is new in the transcript and folds it into state.
function tally(transcriptPath, state, now) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return state;
  }
  try {
    const size = fs.fstatSync(fd).size;
    // Transcript replaced or truncated (a resumed or compacted session): start over.
    if (size < state.offset) {
      state.offset = 0;
      state.output = 0;
      state.window = [];
      state.seen = [];
    }
    if (size === state.offset) return state;

    const len = size - state.offset;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, state.offset);
    const text = buf.toString('utf8');

    // Only consume up to the last complete line; the tail may be mid-write.
    const cut = text.lastIndexOf('\n');
    if (cut === -1) return state;
    state.offset += Buffer.byteLength(text.slice(0, cut + 1), 'utf8');

    const seen = new Set(state.seen);
    for (const line of text.slice(0, cut).split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const usage = entry && entry.message && entry.message.usage;
      if (!usage) continue;
      // Streaming can log the same assistant message more than once.
      const id = entry.message.id || entry.uuid;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const out = usage.output_tokens || 0;
      if (!out) continue;
      state.output += out;
      const at = Date.parse(entry.timestamp || '') || now;
      state.window.push([at, out]);
    }
    // Bound both caches. 400 ids covers any plausible streaming overlap.
    state.seen = [...seen].slice(-400);
    return state;
  } catch {
    return state;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function burnRate(state, now, minutes) {
  const cutoff = now - minutes * 60000;
  state.window = state.window.filter(([at]) => at >= cutoff);
  return state.window.reduce((sum, [, out]) => sum + out, 0);
}

function fmt(n) {
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
}

function decide(cfg, state, now) {
  const hard = cfg.budget * cfg.hardRatio;
  const soft = cfg.budget * cfg.softRatio;
  const recent = burnRate(state, now, cfg.burnMinutes);
  const spent = state.output;

  if (spent >= hard) {
    const head =
      `Token budget spent: ${fmt(spent)} of ${fmt(cfg.budget)} output tokens. ` +
      `Tool calls are blocked. Summarise for the user what is done and what is left.`;
    return {
      deny: true,
      message: cfg.budget >= cfg.ceiling
        ? head + ` This is the ceiling (${fmt(cfg.ceiling)}) — only the user can lift ` +
          `it, in ~/.claude/governor.json. Agree a smaller plan, or a fresh session.`
        : head + ` If the remaining work genuinely needs it, say so in chat and raise ` +
          `"budget" in .claude/governor.json (headroom to ${fmt(cfg.ceiling)}, the ` +
          `ceiling only the user can lift). Do not raise it to keep a loop going.`,
    };
  }

  const canWarn = (last) => now - last >= cfg.rewarnMinutes * 60000;


  if (recent >= cfg.burnTokens && canWarn(state.burnWarnedAt)) {
    state.burnWarnedAt = now;
    return {
      deny: false,
      message:
        `Burn rate: ${fmt(recent)} output tokens in the last ${cfg.burnMinutes} minutes ` +
        `(${fmt(spent)} of ${fmt(cfg.budget)} used). Before the next expensive step, check ` +
        `the current approach is converging. If it is looping or fanning out wider than ` +
        `the task needs, replan smaller instead of pushing on.`,
    };
  }

  if (spent >= soft && canWarn(state.softWarnedAt)) {
    state.softWarnedAt = now;
    return {
      deny: false,
      message:
        `${fmt(spent)} of ${fmt(cfg.budget)} output tokens used ` +
        `(${Math.round((spent / cfg.budget) * 100)}%). Tool calls stop at ` +
        `${fmt(cfg.budget)}. Prioritise what remains: finish the work that matters ` +
        `most first and drop anything optional.`,
    };
  }

  return null;
}

// A hard deny blocks every tool, including the edit that would raise the
// budget — which strands the session until someone opens the file by hand.
// So config edits stay allowed, and that IS the self-extension: a denied
// session can hand itself more budget, up to the ceiling. The user file, where
// the ceiling lives, stays readable but not writable while denied — otherwise
// the ceiling is only a suggestion. (Bash was never exempt, nor is it now.)
function samePath(a, b) {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function targetsConfig(input, home = os.homedir()) {
  if (!['Read', 'Edit', 'Write', 'NotebookEdit'].includes(input.tool_name)) return false;
  const f = input.tool_input && input.tool_input.file_path;
  if (typeof f !== 'string' || path.basename(f) !== 'governor.json') return false;
  return input.tool_name === 'Read' || !samePath(f, userConfig(home));
}

function main() {
  if (process.env.GOVERNOR_OFF === '1') return;

  let input;
  try { input = JSON.parse(readStdin()); } catch { return; }
  if (!input || !input.session_id || !input.transcript_path) return;

  const cfg = loadConfig(input.cwd);
  if (!cfg.enabled) return;

  const now = Date.now();
  const state = tally(input.transcript_path, loadState(input.session_id), now);
  const verdict = decide(cfg, state, now);
  saveState(input.session_id, state);
  if (!verdict) return;
  if (verdict.deny && targetsConfig(input)) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.deny ? 'deny' : 'allow',
      ...(verdict.deny
        ? { permissionDecisionReason: verdict.message }
        : { additionalContext: 'governor: ' + verdict.message }),
    },
    systemMessage: 'governor: ' + verdict.message,
  }));
}

// --- self check -------------------------------------------------------------
// node hooks/governor.js --selftest
function selftest() {
  const assert = require('assert');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'governor-test-'));
  const file = path.join(dir, 't.jsonl');
  const cfg = { ...DEFAULTS, budget: 1000, burnTokens: 400, burnMinutes: 5 };
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const line = (id, out, at) =>
    JSON.stringify({ uuid: id, timestamp: new Date(at).toISOString(), message: { id, usage: { output_tokens: out } } }) + '\n';

  // Under budget: silent.
  fs.writeFileSync(file, line('a', 100, t0));
  let st = tally(file, loadState('selftest'), t0);
  assert.strictEqual(st.output, 100);
  assert.strictEqual(decide(cfg, st, t0), null, 'quiet under the soft gate');

  // Incremental: appended lines are counted once, earlier ones are not re-read.
  fs.appendFileSync(file, line('b', 550, t0 + 1000));
  st = tally(file, st, t0);
  assert.strictEqual(st.output, 650, 'incremental read does not double count');
  // Judged six minutes later, so the burn window is empty and the soft gate is
  // what speaks. Live, the burn gate would win — it is the more urgent signal.
  const late = t0 + 6 * 60000;
  let v = decide(cfg, st, late);
  assert.ok(v && !v.deny, 'soft gate warns, does not deny');
  assert.ok(/65%/.test(v.message), 'soft gate reports the percentage');

  // A duplicated line (streaming) must not be counted twice.
  fs.appendFileSync(file, line('b', 550, t0 + 1500));
  st = tally(file, st, t0);
  assert.strictEqual(st.output, 650, 'duplicate message id ignored');

  // Warnings do not repeat inside the re-warn window.
  assert.strictEqual(decide(cfg, st, late + 2000), null, 'no re-warn immediately after');

  // A partial trailing line is left for the next call.
  fs.appendFileSync(file, '{"message":{"usage":{"output_tok');
  const before = st.output;
  st = tally(file, st, t0);
  assert.strictEqual(st.output, before, 'partial line not consumed');
  fs.appendFileSync(file, 'ens":50},"id":"c"},"uuid":"c","timestamp":"2026-01-01T00:00:03.000Z"}\n');
  st = tally(file, st, t0);
  assert.strictEqual(st.output, before + 50, 'line counted once completed');

  // Over budget: deny.
  fs.appendFileSync(file, line('d', 400, t0 + 4000));
  st = tally(file, st, t0);
  v = decide(cfg, st, late + 4000);
  assert.ok(v && v.deny, 'hard gate denies past budget');

  // Burn rate fires on its own, well under budget.
  const fast = { offset: 0, output: 300, window: [[t0, 300]], seen: [], softWarnedAt: 0, burnWarnedAt: 0 };
  const burn = { ...cfg, burnTokens: 250 };
  v = decide(burn, fast, t0 + 60000);
  assert.ok(v && !v.deny && /Burn rate/.test(v.message), 'burn gate warns under budget');

  // The escape hatch: editing the config is never blocked, so a denied session
  // can still be given a bigger budget from inside.
  assert.ok(targetsConfig({ tool_name: 'Edit', tool_input: { file_path: 'D:/p/.claude/governor.json' } }), 'editing the config is exempt');
  assert.ok(targetsConfig({ tool_name: 'Read', tool_input: { file_path: '/home/u/.claude/governor.json' } }), 'reading the config is exempt');
  assert.ok(!targetsConfig({ tool_name: 'Bash', tool_input: { command: 'vi governor.json' } }), 'bash is never exempt');
  assert.ok(!targetsConfig({ tool_name: 'Edit', tool_input: { file_path: 'src/governor.json.bak' } }), 'only the config itself is exempt');
  assert.ok(!targetsConfig({ tool_name: 'Edit', tool_input: {} }), 'missing path is not exempt');

  // At the ceiling there is nothing left to extend, and the message says so.
  v = decide({ ...cfg, budget: 1000, ceiling: 1000 }, st, late + 4000);
  assert.ok(/only the user can lift/.test(v.message), 'no self-extension offered at the ceiling');
  v = decide({ ...cfg, budget: 1000, ceiling: 4000 }, st, late + 4000);
  assert.ok(/headroom to 4k/.test(v.message), 'headroom named while under the ceiling');

  // The ceiling belongs to the user file: a project config cannot raise its
  // own hard stop, only lower it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'governor-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'governor-proj-'));
  const userFile = path.join(home, '.claude', 'governor.json');
  const projFile = path.join(proj, '.claude', 'governor.json');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.mkdirSync(path.dirname(projFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify({ budget: 200000, ceiling: 300000 }));
  fs.writeFileSync(projFile, JSON.stringify({ budget: 999999, ceiling: 999999 }));
  let loaded = loadConfig(proj, home);
  assert.strictEqual(loaded.ceiling, 300000, 'project cannot raise the ceiling');
  assert.strictEqual(loaded.budget, 300000, 'budget clamped to the ceiling');
  fs.writeFileSync(projFile, JSON.stringify({ budget: 50000 }));
  assert.strictEqual(loadConfig(proj, home).budget, 50000, 'a smaller project budget is honoured');

  // ...and the escape hatch stops at the same line: the user file stays
  // readable while denied, but only the project file can be written.
  assert.ok(targetsConfig({ tool_name: 'Read', tool_input: { file_path: userFile } }, home), 'user config stays readable');
  assert.ok(!targetsConfig({ tool_name: 'Edit', tool_input: { file_path: userFile } }, home), 'user config is not writable while denied');
  assert.ok(targetsConfig({ tool_name: 'Write', tool_input: { file_path: projFile } }, home), 'project config is the self-extension');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });

  // Stale spend falls out of the window.
  assert.strictEqual(burnRate(fast, t0 + 10 * 60000, 5), 0, 'window expires');

  // Truncated transcript resets rather than going negative.
  fs.writeFileSync(file, line('e', 10, t0));
  st = tally(file, st, t0);
  assert.strictEqual(st.output, 10, 'reset on truncation');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('governor selftest ok');
}

if (process.argv.includes('--selftest')) selftest();
else main();
