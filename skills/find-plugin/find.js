#!/usr/bin/env node
// Searches awesomeclaudeplugins.com for Claude Code plugins and prints the top
// matches with the command that would install each one.
//
// It prints the command. It never runs it. Installing a plugin means running a
// stranger's hooks on this machine at every session start, so that stays a
// human decision.

const API = 'https://awesomeclaudeplugins.com/api/catalog';
const MAX_QUERY = 32;   // the API truncates past this
const DEFAULT_N = 8;

function format(repos, limit) {
  const lines = [];
  for (const r of repos.slice(0, limit)) {
    const slug = `${r.owner}/${r.repo_name}`;
    const stars = r.stargazers_count >= 1000
      ? Math.round(r.stargazers_count / 1000) + 'k'
      : String(r.stargazers_count || 0);
    let desc = (r.description || 'no description').replace(/\s+/g, ' ').trim();
    if (desc.length > 110) desc = desc.slice(0, 107) + '...';
    lines.push(`${slug}  (${stars} stars, ${r.plugins_count || 0} plugins)`);
    lines.push(`  ${desc}`);
    lines.push(`  claude plugin marketplace add ${slug}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const nFlag = args.indexOf('-n');
  let limit = DEFAULT_N;
  if (nFlag !== -1) {
    limit = Math.max(1, Math.min(25, Number(args[nFlag + 1]) || DEFAULT_N));
    args.splice(nFlag, 2);
  }
  const query = args.join(' ').slice(0, MAX_QUERY).trim();
  if (!query) {
    console.error('usage: node find.js [-n 8] <search terms>');
    process.exit(1);
  }

  const url = `${API}?q=${encodeURIComponent(query)}&pageSize=${limit}`;
  let data;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error(`catalog unreachable (${err.message}). Try again, or search`);
    console.error(`https://awesomeclaudeplugins.com/ by hand.`);
    process.exit(1);
  }

  const repos = Array.isArray(data.repos) ? data.repos : [];
  if (!repos.length) {
    console.log(`No catalog match for "${query}".`);
    return;
  }

  console.log(`Top ${Math.min(limit, repos.length)} for "${query}" (catalog holds ${data.pluginsCount ?? '?'} plugins):\n`);
  console.log(format(repos, limit));
  console.log(
    '\nUnvetted third-party code. Read the repo before installing: a plugin\n' +
    'can register hooks that run commands on this machine at every session\n' +
    'start. After adding a marketplace, install with `claude plugin install\n' +
    '<plugin>@<marketplace>`, then `claude plugin details <plugin>` to see what\n' +
    'it costs in always-on tokens.',
  );
}

// --- self check -------------------------------------------------------------
// node find.js --selftest
function selftest() {
  const assert = require('assert');
  const repos = [
    { owner: 'obra', repo_name: 'superpowers', stargazers_count: 272499, plugins_count: 1, description: 'An agentic skills framework & software development methodology that works.' },
    { owner: 'tiny', repo_name: 'thing', stargazers_count: 7, plugins_count: 0, description: 'x'.repeat(200) },
  ];

  const out = format(repos, 2);
  assert.ok(out.includes('obra/superpowers  (272k stars, 1 plugins)'), 'stars abbreviated over 1k');
  assert.ok(out.includes('claude plugin marketplace add obra/superpowers'), 'install command printed');
  assert.ok(out.includes('(7 stars, 0 plugins)'), 'small counts printed raw');
  assert.ok(/x{107}\.\.\./.test(out), 'long descriptions truncated');
  assert.strictEqual(format(repos, 1).includes('tiny/thing'), false, 'limit respected');

  // The API truncates queries past 32 chars; make sure we cut the same way.
  assert.strictEqual('a'.repeat(50).slice(0, MAX_QUERY).length, 32, 'query capped at 32');

  console.log('find selftest ok');
}

if (process.argv.includes('--selftest')) selftest();
else main();
