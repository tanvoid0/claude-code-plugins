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
  // Output tokens alone undercount tool-heavy work badly: a turn can read
  // 300k cached tokens and emit 168. Weighted mode counts every token class at
  // its price relative to output, so the budget tracks cost instead. Same unit
  // either way -- the budget is output-token equivalents.
  weighted: false,
  softRatio: 0.6,        // warn once at 60% of budget
  hardRatio: 1.0,        // deny tool calls at 100%
  burnTokens: 25000,     // ...or if this many output tokens land
  burnMinutes: 5,        // ...inside this window
  rewarnMinutes: 10,     // floor between repeated warnings
};

// State lives under the user's home, not os.tmpdir(): on Linux and macOS /tmp
// is world-writable, so a predictable path there lets any other local user
// read, poison or symlink the tally.
const STATE_DIR = path.join(os.homedir(), '.claude', 'governor-state');

// Opus rates, relative to output: input 5/25, cache write 6.25/25, cache read
// 0.5/25. The cheapest class still counts, because there is usually 1000x more
// of it than there is output.
const WEIGHTS = { input: 0.2, cacheWrite: 0.25, cacheRead: 0.02 };

function weigh(u, weighted) {
  const out = u.output_tokens || 0;
  if (!weighted) return out;
  return out
    + WEIGHTS.input * (u.input_tokens || 0)
    + WEIGHTS.cacheWrite * (u.cache_creation_input_tokens || 0)
    + WEIGHTS.cacheRead * (u.cache_read_input_tokens || 0);
}

// The first call after a resume can face a very large transcript. Read at most
// this much per invocation and let the next call catch up, rather than pulling
// a multi-hundred-MB delta into memory inside a 5s hook.
const MAX_READ = 8 << 20;

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

// A denied session is still allowed to edit the project config — that is the
// escape hatch. So the project file must not be able to switch the gate off,
// or the hatch is a bypass and the ceiling is decoration. The project may tune
// when the gate speaks; whether it stops at all belongs to the user file.
const PROJECT_FIELDS = ['budget', 'burnTokens', 'burnMinutes', 'rewarnMinutes'];

function loadConfig(cwd, home = os.homedir()) {
  // User config wins over defaults; the project file then adjusts the fields it
  // is allowed to. A missing or malformed file is not an error — just defaults.
  const cfg = { ...DEFAULTS };
  const user = userConfig(home);
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(user, 'utf8')));
  } catch { /* absent or unparseable: keep the defaults */ }

  if (cwd) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'governor.json'), 'utf8'));
      for (const k of PROJECT_FIELDS) {
        if (typeof raw[k] === 'number') cfg[k] = raw[k];
      }
    } catch { /* absent or unparseable: keep what we have */ }
  }

  if (typeof cfg.ceiling !== 'number' || !(cfg.ceiling > 0)) cfg.ceiling = DEFAULTS.ceiling;
  if (typeof cfg.budget !== 'number' || !(cfg.budget > 0)) cfg.budget = DEFAULTS.budget;
  cfg.budget = Math.min(cfg.budget, cfg.ceiling);
  return cfg;
}

function freshState() {
  return { offset: 0, output: 0, window: [], seen: [], softWarnedAt: 0, burnWarnedAt: 0, weighted: false };
}

// The state file is input, not memory: it outlives the process and sits on
// disk. Every field is checked, so a truncated or tampered file costs the tally
// and nothing else — before this, a non-array `window` threw on the next tool
// call and kept throwing for the rest of the session.
function loadState(sessionId) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  try {
    const s = JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
    if (!s || typeof s !== 'object') return freshState();
    return {
      offset: num(s.offset),
      output: num(s.output),
      window: Array.isArray(s.window)
        ? s.window.filter((e) => Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'number')
        : [],
      seen: Array.isArray(s.seen) ? s.seen.filter((id) => typeof id === 'string') : [],
      softWarnedAt: num(s.softWarnedAt),
      burnWarnedAt: num(s.burnWarnedAt),
      weighted: !!s.weighted,
    };
  } catch { /* absent, unreadable or malformed: first call this session */ }
  return freshState();
}

// session_id arrives over stdin. It is a uuid in practice, but it names a file,
// so anything outside [A-Za-z0-9._-] is replaced rather than trusted.
function statePath(sessionId) {
  return path.join(
    STATE_DIR,
    String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) + '.json',
  );
}

function saveState(sessionId, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(statePath(sessionId), JSON.stringify(state), { mode: 0o600 });
  } catch { /* a lost tally is better than a broken tool call */ }
}

// Reads whatever is new in the transcript and folds it into state.
function tally(transcriptPath, state, now, weighted) {
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

    const len = Math.min(size - state.offset, MAX_READ);
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
      const out = weigh(usage, weighted);
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
  // Weighted tallies are fractional; nobody wants to read 131847.4.
  const v = Math.round(n);
  return v >= 1000 ? Math.round(v / 1000) + 'k' : String(v);
}

function decide(cfg, state, now) {
  // Both ends clamped: no combination of budget and ratio puts the stop past
  // the ceiling, and the soft warning cannot land after the hard one.
  const hard = Math.min(cfg.budget * cfg.hardRatio, cfg.ceiling);
  const soft = Math.min(cfg.budget * cfg.softRatio, hard);
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
  const prior = loadState(input.session_id);
  // Switching modes mid-session would add weighted numbers to unweighted ones.
  // Start the tally over instead of reporting a figure that means neither.
  if (!!prior.weighted !== !!cfg.weighted) {
    Object.assign(prior, freshState());
  }
  prior.weighted = !!cfg.weighted;
  const state = tally(input.transcript_path, prior, now, cfg.weighted);
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

  // A project file may tune the warnings. It may not switch the gate off, or
  // stretch the ratio past the ceiling — a denied session is allowed to write
  // this file, so anything it can set here it can set to escape.
  fs.writeFileSync(projFile, JSON.stringify({ enabled: false, hardRatio: 100, softRatio: 99, ceiling: 9e9 }));
  loaded = loadConfig(proj, home);
  assert.strictEqual(loaded.enabled, true, 'project cannot disable the gate');
  assert.strictEqual(loaded.hardRatio, DEFAULTS.hardRatio, 'project cannot stretch hardRatio');
  assert.strictEqual(loaded.softRatio, DEFAULTS.softRatio, 'project cannot stretch softRatio');
  assert.strictEqual(loaded.ceiling, 300000, 'project cannot set the ceiling');
  fs.writeFileSync(projFile, JSON.stringify({ burnTokens: 999, burnMinutes: 2 }));
  loaded = loadConfig(proj, home);
  assert.strictEqual(loaded.burnTokens, 999, 'project tunes the burn window');
  assert.strictEqual(loaded.burnMinutes, 2, 'project tunes the burn window');

  // Even with a hostile ratio in hand, the stop lands on the ceiling.
  const stretched = { ...cfg, budget: 1000, ceiling: 1000, hardRatio: 100 };
  assert.ok(decide(stretched, { ...st, output: 1200 }, late).deny, 'ceiling caps the stop');

  // ...and the escape hatch stops at the same line: the user file stays
  // readable while denied, but only the project file can be written.
  assert.ok(targetsConfig({ tool_name: 'Read', tool_input: { file_path: userFile } }, home), 'user config stays readable');
  assert.ok(!targetsConfig({ tool_name: 'Edit', tool_input: { file_path: userFile } }, home), 'user config is not writable while denied');
  assert.ok(targetsConfig({ tool_name: 'Write', tool_input: { file_path: projFile } }, home), 'project config is the self-extension');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });

  // A tampered or truncated state file costs the tally and nothing else. This
  // used to throw on every tool call for the rest of the session.
  for (const bad of ['{"offset":0,"output":5,"window":"nope","seen":[]}', '{"window":[[1,2],"x"],"seen":[1,2]}', 'not json', '[]', 'null']) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath('selftest-bad'), bad);
    const s2 = loadState('selftest-bad');
    assert.ok(Array.isArray(s2.window) && Array.isArray(s2.seen), 'state arrays always arrays: ' + bad);
    assert.doesNotThrow(() => decide(cfg, s2, t0), 'malformed state does not throw: ' + bad);
  }
  fs.rmSync(statePath('selftest-bad'), { force: true });

  // session_id names a file, so it cannot walk out of the state directory.
  for (const id of ['../../evil', 'a/b', 'C:\\Windows\\x', '..', '']) {
    assert.strictEqual(path.dirname(statePath(id)), STATE_DIR, 'state stays in its directory: ' + id);
  }

  // Weighted mode: a turn that emits almost nothing but reads a huge cache is
  // expensive, and unweighted counting cannot see it. Measured from the
  // benchmark: 168 output tokens against 322,512 cache reads cost $0.3562, of
  // which output was $0.0042 -- 1.2%.
  const heavy = { output_tokens: 168, input_tokens: 14, cache_creation_input_tokens: 30503, cache_read_input_tokens: 322512 };
  assert.strictEqual(weigh(heavy, false), 168, 'unweighted sees only output');
  const w = weigh(heavy, true);
  assert.ok(w > 14000 && w < 14500, 'weighted sees the cache reads, got ' + w);
  // The weights are the opus price ratios, so weighted tokens track dollars.
  const dollars = (14 * 5 + 168 * 25 + 30503 * 6.25 + 322512 * 0.5) / 1e6;
  assert.ok(Math.abs((w / 1e6) * 25 - dollars) < 1e-9, 'weighted total is cost-proportional');

  const wfile = path.join(dir, 'w.jsonl');
  fs.writeFileSync(wfile, JSON.stringify({ uuid: 'w1', timestamp: new Date(t0).toISOString(), message: { id: 'w1', usage: heavy } }) + '\n');
  const unw = tally(wfile, freshState(), t0, false);
  assert.strictEqual(unw.output, 168, 'unweighted tally unchanged by the new path');
  const wt = tally(wfile, freshState(), t0, true);
  assert.ok(wt.output > 13000, 'weighted tally counts the whole turn');

  // A turn with zero output still counts when weighted.
  const noOut = { output_tokens: 0, cache_read_input_tokens: 500000 };
  assert.strictEqual(weigh(noOut, false), 0, 'zero-output turn is invisible unweighted');
  assert.strictEqual(weigh(noOut, true), 10000, 'zero-output turn still costs, weighted');

  // Mode is user-file-only: a project file cannot quietly switch the gate back
  // to the metric that undercounts it.
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'governor.json'), JSON.stringify({ weighted: true, ceiling: 300000 }));
  fs.writeFileSync(path.join(proj, '.claude', 'governor.json'), JSON.stringify({ weighted: false }));
  assert.strictEqual(loadConfig(proj, home).weighted, true, 'project cannot turn weighting off');

  // Fractional weighted totals print as whole numbers.
  assert.strictEqual(fmt(131847.4), '132k', 'weighted totals round');
  assert.strictEqual(fmt(12.6), '13', 'small weighted totals round');

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
// The header promises this never throws. Make that structural rather than a
// property of every line above it: a hook that dies noisily on every tool call
// is worse than one that quietly lets the call through.
else try { main(); } catch { /* fail open */ }
