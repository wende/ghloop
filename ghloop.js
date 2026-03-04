#!/usr/bin/env node
'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- CLI parsing ---

function parseArgs(argv) {
  const args = { pr: '', interval: 15, stateDir: '' };
  let i = 2;
  while (i < argv.length) {
    switch (argv[i]) {
      case '--pr':
      case '-p':
        args.pr = argv[++i];
        break;
      case '--interval':
      case '-i':
        args.interval = parseInt(argv[++i], 10);
        break;
      case '--state-dir':
        args.stateDir = argv[++i];
        break;
      case '--help':
      case '-h':
        console.log(`Usage: ghloop [--pr <number>] [--interval <seconds>] [--state-dir <path>]

Watches a GitHub PR for CI status changes and new comments.
Uses "gh pr checks --watch" for CI (no polling) and polls for new comments.

Options:
  -p, --pr <number>        PR number (default: auto-detect from current branch)
  -i, --interval <seconds> Comment poll interval in seconds (default: 15)
      --state-dir <path>   State persistence directory (default: <git-dir>/ghloop/)
  -h, --help               Show this help`);
        process.exit(0);
        break;
      default:
        die(`Unknown argument: ${argv[i]}`);
    }
    i++;
  }
  if (isNaN(args.interval) || args.interval < 1) die('Interval must be a positive integer');
  if (args.pr && !/^\d+$/.test(args.pr)) die('PR number must be numeric');
  return args;
}

// --- Helpers ---

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    die(`command failed: ${cmd} ${args.join(' ')}\n${e.stderr || e.message}`);
  }
}

function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// --- Core functions ---

function resolvePr(prArg) {
  if (prArg) return prArg;
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') die('Detached HEAD; provide --pr <number>');
  const num = run('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', 'number', '--jq', '.[0].number // empty']);
  if (!num) die(`No open PR found for branch: ${branch}`);
  return num;
}

function fetchChecks(prNumber) {
  try {
    const raw = execFileSync('gh', ['pr', 'checks', String(prNumber), '--json', 'name,state,workflow'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return JSON.parse(raw || '[]')
      .map(c => ({ workflow: c.workflow || '', name: c.name || '', state: c.state || '' }))
      .sort((a, b) => (a.workflow + a.name).localeCompare(b.workflow + b.name));
  } catch {
    return [];
  }
}

function fetchCommentCounts(prNumber, repo) {
  const apiJson = JSON.parse(run('gh', ['api', `repos/${repo}/pulls/${prNumber}`]));
  const issue = apiJson.comments || 0;
  const review = apiJson.review_comments || 0;
  return { issue, review, total: issue + review };
}

function fetchState(prNumber, repo) {
  const viewJson = JSON.parse(run('gh', ['pr', 'view', String(prNumber), '--json', 'title,url']));
  const comments = fetchCommentCounts(prNumber, repo);
  const checks = fetchChecks(prNumber);

  return {
    fetchedAt: new Date().toISOString(),
    repo,
    prNumber,
    prTitle: viewJson.title,
    prUrl: viewJson.url,
    comments,
    checks,
  };
}

function statesDiffer(a, b) {
  if (a.comments.total !== b.comments.total) return true;
  if (a.comments.issue !== b.comments.issue) return true;
  if (a.comments.review !== b.comments.review) return true;
  return checksDiffer(a.checks, b.checks);
}

function checksDiffer(a, b) {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].state !== b[i].state) return true;
    if (a[i].name !== b[i].name) return true;
    if (a[i].workflow !== b[i].workflow) return true;
  }
  return false;
}

function printSummary(state) {
  const { comments, checks } = state;
  console.log(`Comments: total=${comments.total} (issue=${comments.issue}, review=${comments.review})`);
  if (checks.length === 0) {
    console.log('Checks: none reported');
    return;
  }
  const grouped = {};
  for (const c of checks) grouped[c.state] = (grouped[c.state] || 0) + 1;
  console.log('Checks: ' + Object.entries(grouped).map(([k, v]) => `${k}: ${v}`).join(', '));
}

function printChanges(oldState, newState) {
  const changes = [];
  if (oldState.comments.total !== newState.comments.total)
    changes.push(`- Total comments: ${oldState.comments.total} -> ${newState.comments.total}`);
  if (oldState.comments.issue !== newState.comments.issue)
    changes.push(`- Issue comments: ${oldState.comments.issue} -> ${newState.comments.issue}`);
  if (oldState.comments.review !== newState.comments.review)
    changes.push(`- Review comments: ${oldState.comments.review} -> ${newState.comments.review}`);

  const oldMap = {};
  for (const c of oldState.checks) oldMap[`${c.workflow}|${c.name}`] = c.state;
  const newMap = {};
  for (const c of newState.checks) newMap[`${c.workflow}|${c.name}`] = c.state;

  const allKeys = [...new Set([...Object.keys(oldMap), ...Object.keys(newMap)])].sort();
  for (const key of allKeys) {
    const os = oldMap[key] || 'missing';
    const ns = newMap[key] || 'missing';
    if (os !== ns) {
      const [workflow, name] = key.split('|');
      changes.push(workflow
        ? `- Check [${workflow} / ${name}]: ${os} -> ${ns}`
        : `- Check [${name}]: ${os} -> ${ns}`);
    }
  }

  if (changes.length === 0) {
    console.log('- PR state changed');
  } else {
    changes.forEach(c => console.log(c));
  }
}

function fetchAndPrintNewComments(prNumber, repo, sinceDate) {
  let prComments = [];
  try {
    const raw = run('gh', ['pr', 'view', String(prNumber), '--json', 'comments', '--jq', '.comments[]?']);
    if (raw) prComments = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { /* empty */ }

  const since = new Date(sinceDate);
  const newPrComments = prComments.filter(c => new Date(c.createdAt) > since);

  let reviewComments = [];
  try {
    reviewComments = JSON.parse(run('gh', ['api', '--paginate', `repos/${repo}/pulls/${prNumber}/comments`]));
  } catch { /* empty */ }
  const newReviewComments = reviewComments.filter(c => new Date(c.created_at) > since);

  if (newPrComments.length === 0 && newReviewComments.length === 0) return;

  console.log('');
  console.log('================================================================================');
  console.log('NEW COMMENTS');
  console.log('================================================================================');

  for (const c of newPrComments) {
    console.log('');
    console.log(`Author: ${c.author?.login || 'unknown'}`);
    console.log(`Date: ${c.createdAt}`);
    if (c.url) console.log(`URL: ${c.url}`);
    console.log('');
    console.log(c.body);
    console.log('\u2500'.repeat(80));
  }

  for (const c of newReviewComments) {
    console.log('');
    console.log(`File: ${c.path}:${c.line || c.original_line || 'N/A'}`);
    console.log(`Author: ${c.user?.login || 'unknown'}`);
    console.log(`Date: ${c.created_at}`);
    if (c.html_url) console.log(`URL: ${c.html_url}`);
    if (c.diff_hunk) {
      const lines = c.diff_hunk.split('\n').slice(-3);
      console.log('');
      console.log('Context:');
      lines.forEach(l => console.log(`  ${l}`));
    }
    console.log('');
    console.log(c.body);
    console.log('\u2500'.repeat(80));
  }
}

// --- Watch strategies ---

/**
 * Spawns `gh pr checks --watch` and resolves only when checks actually change.
 * If checks are already in a terminal state and --watch exits immediately,
 * we detect that nothing changed and don't resolve — letting comment polling continue.
 */
function watchChecksViaGh(prNumber, baselineChecks) {
  return new Promise((resolve) => {
    const child = spawn('gh', ['pr', 'checks', String(prNumber), '--watch', '--fail-fast'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => {
      if (code !== 0 && stderr) {
        console.error(`gh pr checks --watch exited with code ${code}: ${stderr.trim()}`);
      }
      const currentChecks = fetchChecks(prNumber);
      if (checksDiffer(baselineChecks, currentChecks)) {
        resolve({ source: 'checks', code, checks: currentChecks });
      }
      // If unchanged, don't resolve — let comment polling handle it
    });
    child.on('error', () => {
      // gh pr checks --watch not available — never resolve, let comment polling handle it
    });
    watchChecksViaGh._child = child;
  });
}

/** Polls comment counts until they change from baseline */
function watchComments(prNumber, repo, baseline, intervalSeconds) {
  return new Promise(async (resolve) => {
    while (true) {
      await sleep(intervalSeconds);
      try {
        const counts = fetchCommentCounts(prNumber, repo);
        if (counts.total !== baseline.total || counts.issue !== baseline.issue || counts.review !== baseline.review) {
          resolve({ source: 'comments', counts });
          return;
        }
      } catch {
        // transient API error, keep polling
      }
    }
  });
}

function cleanup() {
  if (watchChecksViaGh._child) {
    try { watchChecksViaGh._child.kill(); } catch { /* already exited */ }
  }
}

// --- Main ---

async function main() {
  const args = parseArgs(process.argv);
  const prNumber = resolvePr(args.pr);
  const repo = JSON.parse(run('gh', ['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;

  let stateDir = args.stateDir;
  if (!stateDir) {
    const gitCommonDir = run('git', ['rev-parse', '--git-common-dir']);
    stateDir = path.join(gitCommonDir, 'ghloop');
  }
  fs.mkdirSync(stateDir, { recursive: true });

  const repoSlug = repo.replace(/[/:]/g, '__');
  const stateFile = path.join(stateDir, `${repoSlug}-pr${prNumber}.json`);

  // Fetch current state
  const currentState = fetchState(prNumber, repo);

  // Check against saved state (relaunch detection)
  if (fs.existsSync(stateFile)) {
    const savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (statesDiffer(savedState, currentState)) {
      console.log(`Changes detected since last run for PR #${prNumber} (${repo})`);
      printChanges(savedState, currentState);
      if (currentState.comments.total > savedState.comments.total) {
        fetchAndPrintNewComments(prNumber, repo, savedState.fetchedAt);
      }
      fs.writeFileSync(stateFile, JSON.stringify(currentState, null, 2));
      process.exit(0);
    }
  }

  // Save baseline
  fs.writeFileSync(stateFile, JSON.stringify(currentState, null, 2));

  console.log(`Watching PR #${prNumber} in ${repo}`);
  console.log(`PR: ${currentState.prUrl}`);
  console.log(`CI: using "gh pr checks --watch" (event-driven)`);
  console.log(`Comments: polling every ${args.interval}s`);
  printSummary(currentState);
  console.log('');

  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  // Race: gh pr checks --watch vs comment polling
  const result = await Promise.race([
    watchChecksViaGh(prNumber, currentState.checks),
    watchComments(prNumber, repo, currentState.comments, args.interval),
  ]);

  cleanup();

  // Fetch full final state for accurate diff
  const finalState = fetchState(prNumber, repo);

  console.log(`Update detected at ${new Date().toISOString()}`);
  printChanges(currentState, finalState);
  if (finalState.comments.total > currentState.comments.total) {
    fetchAndPrintNewComments(prNumber, repo, currentState.fetchedAt);
  }
  fs.writeFileSync(stateFile, JSON.stringify(finalState, null, 2));
  process.exit(0);
}

main().catch(e => {
  cleanup();
  console.error(e.message);
  process.exit(1);
});
