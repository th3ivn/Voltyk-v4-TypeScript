#!/usr/bin/env node

/**
 * Audits unique string values used in outage-data-ua JSON payloads.
 *
 * Usage:
 *   node scripts/audit-outage-values.mjs
 *   node scripts/audit-outage-values.mjs --repo Baskerville42/outage-data-ua --branch main
 *   node scripts/audit-outage-values.mjs --input-dir ./outage-data-ua/data
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_REPO = 'Baskerville42/outage-data-ua';
const DEFAULT_BRANCH = 'main';

function parseArgs(argv) {
  const args = {
    repo: DEFAULT_REPO,
    branch: DEFAULT_BRANCH,
    inputDir: null,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--repo' && argv[i + 1]) {
      args.repo = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === '--branch' && argv[i + 1]) {
      args.branch = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === '--input-dir' && argv[i + 1]) {
      args.inputDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === '--json') {
      args.json = true;
    }
  }

  return args;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Voltyk-v4-TypeScript/audit-outage-values',
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} (${url})`);
  }

  return response.json();
}

function collectStringValues(input, pointer, collector) {
  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i += 1) {
      collectStringValues(input[i], `${pointer}[${i}]`, collector);
    }
    return;
  }

  if (input === null || typeof input !== 'object') {
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    const nextPointer = pointer ? `${pointer}.${key}` : key;

    if (typeof value === 'string') {
      const keyBucket = collector.byKey.get(key) ?? new Map();
      keyBucket.set(value, (keyBucket.get(value) ?? 0) + 1);
      collector.byKey.set(key, keyBucket);

      const normalized = value.trim().toLowerCase();
      collector.globalValues.set(normalized, (collector.globalValues.get(normalized) ?? 0) + 1);

      if (!collector.examples.has(normalized)) {
        collector.examples.set(normalized, nextPointer);
      }
    }

    collectStringValues(value, nextPointer, collector);
  }
}

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function summarize(collector) {
  const statusKeys = ['status', 'type', 'power', 'state', 'value'];
  const byKey = Object.fromEntries(
    statusKeys.map((statusKey) => [
      statusKey,
      sortedEntries(collector.byKey.get(statusKey) ?? new Map()).map(([value, count]) => ({
        value,
        count,
        example: collector.examples.get(value.trim().toLowerCase()) ?? 'n/a',
      })),
    ]),
  );

  const interestingValues = sortedEntries(collector.globalValues)
    .filter(([value]) => ['no', 'yes', 'maybe'].includes(value) || /^[a-z]{2,}$/.test(value))
    .slice(0, 50)
    .map(([value, count]) => ({
      value,
      count,
      example: collector.examples.get(value) ?? 'n/a',
    }));

  return {
    byKey,
    topGlobalValues: interestingValues,
  };
}

async function listLocalFiles(inputDir) {
  const resolvedDir = path.resolve(inputDir);
  const entries = await readdir(resolvedDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => ({
      source: `file://${path.join(resolvedDir, entry.name)}`,
      filePath: entry.name,
      mode: 'local',
    }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

async function listRemoteFiles(repo, branch) {
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`;
  const tree = await fetchJson(treeUrl);

  if (!Array.isArray(tree.tree)) {
    throw new Error('Unexpected tree payload from GitHub API.');
  }

  return tree.tree
    .filter((node) => node.type === 'blob' && typeof node.path === 'string' && node.path.startsWith('data/') && node.path.endsWith('.json'))
    .map((node) => ({
      source: `https://raw.githubusercontent.com/${repo}/${branch}/${node.path}`,
      filePath: node.path,
      mode: 'remote',
    }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

async function loadJson(entry) {
  if (entry.mode === 'local') {
    const fileUrl = new URL(entry.source);
    const content = await readFile(fileUrl, 'utf8');
    return JSON.parse(content);
  }

  return fetchJson(entry.source);
}

function printTextReport(report, sourceLabel, scannedFiles) {
  for (const [key, rows] of Object.entries(report.byKey)) {
    console.log(`\nValues for key "${key}"`);
    if (rows.length === 0) {
      console.log('  (no values found)');
      continue;
    }

    for (const row of rows) {
      console.log(`  - ${row.value} (count=${row.count}, example=${row.example})`);
    }
  }

  console.log('\nTop normalized string values (global):');
  for (const row of report.topGlobalValues) {
    console.log(`  - ${row.value} (count=${row.count}, example=${row.example})`);
  }

  console.log(`\nScanned ${scannedFiles} files from ${sourceLabel}`);
}

async function main() {
  const { repo, branch, inputDir, json } = parseArgs(process.argv.slice(2));
  const sourceLabel = inputDir ? `local directory ${path.resolve(inputDir)}` : `${repo}@${branch}`;

  const entries = inputDir ? await listLocalFiles(inputDir) : await listRemoteFiles(repo, branch);

  if (entries.length === 0) {
    throw new Error('No region JSON files found.');
  }

  const collector = {
    byKey: new Map(),
    globalValues: new Map(),
    examples: new Map(),
  };

  for (const entry of entries) {
    const payload = await loadJson(entry);
    collectStringValues(payload, entry.filePath, collector);
  }

  const report = summarize(collector);

  if (json) {
    console.log(
      JSON.stringify(
        {
          source: sourceLabel,
          scannedFiles: entries.length,
          report,
        },
        null,
        2,
      ),
    );
    return;
  }

  printTextReport(report, sourceLabel, entries.length);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
