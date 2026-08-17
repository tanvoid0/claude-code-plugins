#!/usr/bin/env node
// Reports what every installed plugin costs in always-on context, so the ones
// not earning their keep can be disabled.
//
// Always-on tokens are paid on every session of every project, whether or not
// the plugin is used. That is the number worth pruning.

const { execFileSync } = require('child_process');

function claude(args) {
  return execFileSync('claude', args, { encoding: 'utf8', maxBuffer: 4 << 20 });
}

// "  ❯ caveman@caveman" then "    Status: ✔ enabled"
function parseList(text) {
  const out = [];
  let current = null;
  for (const line of text.split('\n')) {
    const name = line.trim().match(/^\S*\s*([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)$/);
    if (name) {
      current = { name: name[1], marketplace: name[2], enabled: false };
      out.push(current);
      continue;
    }
    if (current && /Status:/.test(line)) current.enabled = /enabled/.test(line);
  }
  return out;
}

function parseDetails(text) {
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
  };
  return {
    alwaysOn: num(/Always-on:\s*~?([\d,]+)\s*tok/),
    skills: num(/Skills \((\d+)\)/),
    agents: num(/Agents \((\d+)\)/),
    hooks: num(/Hooks \((\d+)\)/),
    mcp: num(/MCP servers \((\d+)\)/),
  };
}

function main() {
  let plugins;
  try {
    plugins = parseList(claude(['plugin', 'list']));
  } catch (err) {
    console.error('could not run `claude plugin list`:', err.message);
    process.exit(1);
  }

  const rows = [];
  for (const p of plugins) {
    if (!p.enabled) {
      rows.push({ ...p, alwaysOn: 0, disabled: true });
      continue;
    }
    try {
      rows.push({ ...p, ...parseDetails(claude(['plugin', 'details', p.name])) });
    } catch {
      rows.push({ ...p, alwaysOn: 0, unknown: true });
    }
  }

  const enabled = rows.filter((r) => r.enabled);
  enabled.sort((a, b) => b.alwaysOn - a.alwaysOn);
  const total = enabled.reduce((sum, r) => sum + r.alwaysOn, 0);

  const pad = (s, n) => String(s).padEnd(n);
  console.log('always-on  plugin              components');
  for (const r of enabled) {
    const parts = [];
    if (r.skills) parts.push(r.skills + ' skills');
    if (r.agents) parts.push(r.agents + ' agents');
    if (r.hooks) parts.push(r.hooks + ' hooks');
    if (r.mcp) parts.push(r.mcp + ' mcp');
    console.log(
      pad('~' + r.alwaysOn + ' tok', 11) + pad(r.name, 20) + (parts.join(', ') || 'none'),
    );
  }
  console.log('-'.repeat(52));
  console.log(pad('~' + total + ' tok', 11) + 'total, every session, every project');

  const off = rows.filter((r) => r.disabled).map((r) => r.name);
  if (off.length) console.log('\ndisabled (costing nothing): ' + off.join(', '));

  const worst = enabled.filter((r) => r.alwaysOn >= 300);
  if (worst.length) {
    console.log('\nBiggest payers — disable any you do not use in most sessions:');
    for (const r of worst) console.log(`  claude plugin disable ${r.name}   # ~${r.alwaysOn} tok`);
  }
  console.log('\nHooks and MCP servers cost ~0 always-on: hooks run outside context and');
  console.log('MCP tool schemas load on demand. Skills and agents pay their description');
  console.log('up front in every session, and their body only when invoked.');
}

// --- self check -------------------------------------------------------------
// node audit.js --selftest
function selftest() {
  const assert = require('assert');

  const list = [
    'Installed plugins:',
    '',
    '  ❯ caveman@caveman',
    '    Version: 25d22f864ad6',
    '    Scope: user',
    '    Status: ✔ enabled',
    '',
    '  ❯ claude-mem@thedotmack',
    '    Version: 13.10.2',
    '    Scope: user',
    '    Status: ✘ disabled',
    '',
  ].join('\n');

  const parsed = parseList(list);
  assert.strictEqual(parsed.length, 2, 'both plugins found');
  assert.deepStrictEqual(
    parsed.map((p) => [p.name, p.enabled]),
    [['caveman', true], ['claude-mem', false]],
    'names and enabled state read correctly',
  );

  const details = [
    'crew 0.1.0',
    '  Six subagents.',
    '  Source: crew@crew',
    '',
    'Component inventory',
    '  Skills (0)',
    '  Agents (6)  architect, coder, planner, quick, reviewer, scout',
    '  Hooks (0)',
    '  MCP servers (0)',
    '',
    'Projected token cost',
    '  Always-on:   ~370 tok   added to every session',
  ].join('\n');

  assert.deepStrictEqual(
    parseDetails(details),
    { alwaysOn: 370, skills: 0, agents: 6, hooks: 0, mcp: 0 },
    'cost and component counts parsed',
  );

  // A plugin with no cost line must read as zero, not NaN.
  assert.strictEqual(parseDetails('Skills (2)').alwaysOn, 0, 'missing cost line is zero');

  console.log('audit selftest ok');
}

if (process.argv.includes('--selftest')) selftest();
else main();
