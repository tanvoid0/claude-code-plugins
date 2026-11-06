#!/usr/bin/env node
// SessionStart. Advertises parked skills — but only in a project where they
// could plausibly fire, and only as one line each.
//
// The economics: anything in ~/.claude/skills is listed in every session in
// every project, at its full frontmatter description. Measured locally, 32
// personal skills came to ~11k tokens per turn, on repos where a design or
// image-generation skill never fires once. Parking them removes that listing
// entirely; this hook hands back discovery for ~2% of the price, and only
// where it is worth anything.
//
// A hook cannot remove a skill from the listing — it can only add. So the
// saving comes from where the skill DIRECTORY lives, and this file exists to
// make that trade survivable rather than to do the gating itself.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PARKED = path.join(os.homedir(), '.claude', 'skills-parked');
const MAX = 40;

// Markers that say "a design or frontend skill might earn its place here".
// Deliberately shallow: this runs on every session start, and a wrong guess
// costs either ~300 tokens or a `/governor:skill` the model did not think of.
const FRONTEND = /(^|["/])(react|next|vue|svelte|astro|remix|gatsby|nuxt|solid-js|lit|tailwindcss|vite|@angular)/;

function looksRelevant(cwd) {
  try {
    // A package.json proves nothing on its own: this was caught on a Flutter
    // monorepo whose package.json exists only to hold `npm run release`.
    // Flutter first, and one level down, because the apps are under apps/*.
    if (fs.existsSync(path.join(cwd, 'pubspec.yaml'))) return false;
    const top = fs.readdirSync(cwd, { withFileTypes: true }).slice(0, 200);
    for (const e of top.filter((x) => x.isDirectory()).slice(0, 40)) {
      if (fs.existsSync(path.join(cwd, e.name, 'pubspec.yaml'))) return false;
    }

    const pkg = path.join(cwd, 'package.json');
    if (fs.existsSync(pkg)) {
      const raw = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const deps = JSON.stringify({ ...raw.dependencies, ...raw.devDependencies, ...raw.peerDependencies });
      if (FRONTEND.test(deps)) return true;
    }

    return top.some((e) => e.isFile() && /\.(html|tsx|jsx|vue|svelte|scss)$/i.test(e.name));
  } catch {
    return false;
  }
}

function hint(dir) {
  try {
    const head = fs.readFileSync(path.join(PARKED, dir, 'SKILL.md'), 'utf8').slice(0, 2000);
    const m = head.match(/^description:\s*(.+)$/mi);
    if (!m) return '';
    // First clause only. The full descriptions are what cost 11k in the first place.
    return m[1].replace(/^["']|["']$/g, '').split(/[.;]/)[0].split(/\s+/).slice(0, 9).join(' ');
  } catch {
    return '';
  }
}

function index() {
  let dirs;
  try {
    dirs = fs.readdirSync(PARKED, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(PARKED, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return '';
  }
  if (!dirs.length) return '';

  const lines = dirs.slice(0, MAX).map((d) => `- ${d}: ${hint(d)}`.trimEnd());
  return 'Parked skills (not loaded, so they cost nothing until used). Load one with ' +
    '`/governor:skill <name>`, which reads its SKILL.md and follows it:\n' + lines.join('\n');
}

function main() {
  let cwd = process.cwd();
  try {
    const chunks = [];
    if (!process.stdin.isTTY) {
      const data = fs.readFileSync(0, 'utf8');
      chunks.push(data);
      const ev = JSON.parse(data);
      if (ev && typeof ev.cwd === 'string') cwd = ev.cwd;
    }
  } catch { /* no stdin, or not JSON: fall back to process cwd */ }

  if (!looksRelevant(cwd)) return;      // silence is the whole point

  // Same gate the parked listing rides: where a design skill could fire, the
  // cheapest way to use it is to hand the work to a crew agent that invokes it
  // itself, on a model pinned below this session's.
  const crew = 'Frontend, motion or chart work → hand it to crew:coder, ' +
    'crew:planner or crew:architect; they invoke the fitting design skill ' +
    '(make-interfaces-feel-better, apple-design, animate, dataviz) themselves.';

  const body = index();
  process.stdout.write(body ? `${body}\n\n${crew}` : crew);
}

if (process.argv.includes('--selftest')) {
  const assert = require('assert');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-idx-'));

  const flutter = path.join(tmp, 'flutter');
  fs.mkdirSync(flutter);
  fs.writeFileSync(path.join(flutter, 'pubspec.yaml'), 'name: app');
  fs.writeFileSync(path.join(flutter, 'package.json'), '{}');   // both present
  assert.strictEqual(looksRelevant(flutter), false, 'Flutter wins over a stray package.json');

  const web = path.join(tmp, 'web');
  fs.mkdirSync(web);
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ dependencies: { react: '^18' } }));
  assert.strictEqual(looksRelevant(web), true, 'a react project is relevant');

  // The case this was caught on: a Flutter monorepo whose package.json only
  // holds release scripts, with the apps one level down.
  const mono = path.join(tmp, 'mono');
  fs.mkdirSync(path.join(mono, 'apps', 'gym'), { recursive: true });
  fs.writeFileSync(path.join(mono, 'package.json'), JSON.stringify({ scripts: { release: 'sh x.sh' } }));
  fs.writeFileSync(path.join(mono, 'apps', 'gym', 'pubspec.yaml'), 'name: gym');
  assert.strictEqual(looksRelevant(mono), false, 'a scripts-only package.json over Flutter apps is not relevant');

  const scripts = path.join(tmp, 'scripts-only');
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, 'package.json'), JSON.stringify({ devDependencies: { eslint: '^9' } }));
  assert.strictEqual(looksRelevant(scripts), false, 'a package.json with no frontend dep is not relevant');

  const broken = path.join(tmp, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'package.json'), '{ not json');
  assert.strictEqual(looksRelevant(broken), false, 'a malformed package.json does not throw');

  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'main.go'), 'package main');
  assert.strictEqual(looksRelevant(plain), false, 'a go project is not');

  fs.writeFileSync(path.join(plain, 'index.html'), '<!doctype html>');
  assert.strictEqual(looksRelevant(plain), true, 'a loose html file is');

  assert.strictEqual(looksRelevant(path.join(tmp, 'nope')), false, 'a missing directory is not relevant');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('skill-index selftest ok');
} else {
  try { main(); } catch { /* never break a session start */ }
}
