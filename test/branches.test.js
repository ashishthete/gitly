'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildBranchTree } from '../public/branches.js';

const SAMPLE = [
  { name: 'master', type: 'local', isHead: true },
  { name: 'feat/emission/sync', type: 'local', isHead: false },
  { name: 'feat/emission/link', type: 'local', isHead: false },
  { name: 'origin/develop', type: 'remote', isHead: false },
];

/** Find a direct child by name. */
function child(node, name) {
  return node.children.find((c) => c.name === name);
}

/** Collect all paths in the tree. */
function collectPaths(node, out = []) {
  out.push(node.path);
  if (Array.isArray(node.children)) {
    for (const c of node.children) collectPaths(c, out);
  }
  return out;
}

/** Count all nodes in the tree. */
function countNodes(node) {
  let n = 1;
  if (Array.isArray(node.children)) {
    for (const c of node.children) n += countNodes(c);
  }
  return n;
}

test('root has Local and Remote groups', () => {
  const root = buildBranchTree(SAMPLE);
  assert.equal(root.name, 'branches');
  assert.equal(root.path, '');
  assert.equal(root.type, 'group');

  const groupNames = root.children.map((g) => g.name);
  assert.deepEqual(groupNames, ['Local', 'Remote']);
});

test('Local has feat → emission folders with two leaves, and a master leaf', () => {
  const root = buildBranchTree(SAMPLE);
  const local = child(root, 'Local');

  const feat = child(local, 'feat');
  assert.ok(feat, 'feat folder exists');
  assert.equal(feat.type, 'group');

  const emission = child(feat, 'emission');
  assert.ok(emission, 'emission folder exists');
  assert.equal(emission.type, 'group');

  const leafNames = emission.children.map((c) => c.name).sort();
  assert.deepEqual(leafNames, ['link', 'sync']);

  const master = child(local, 'master');
  assert.ok(master, 'master leaf exists');
  assert.equal(master.type, 'branch');
});

test('leaf nodes carry the full branchName and no children', () => {
  const root = buildBranchTree(SAMPLE);
  const local = child(root, 'Local');
  const emission = child(child(local, 'feat'), 'emission');

  const sync = child(emission, 'sync');
  assert.equal(sync.branchName, 'feat/emission/sync');
  assert.equal(sync.type, 'branch');
  assert.ok(!('children' in sync), 'leaf has no children property');

  const link = child(emission, 'link');
  assert.equal(link.branchName, 'feat/emission/link');
  assert.ok(!('children' in link));
});

test('master leaf has isHead === true', () => {
  const root = buildBranchTree(SAMPLE);
  const local = child(root, 'Local');
  const master = child(local, 'master');
  assert.equal(master.isHead, true);
  assert.equal(master.branchName, 'master');
});

test('Remote group contains origin/develop hierarchy', () => {
  const root = buildBranchTree(SAMPLE);
  const remote = child(root, 'Remote');
  assert.ok(remote, 'Remote group exists');
  const origin = child(remote, 'origin');
  assert.ok(origin, 'origin folder exists');
  assert.equal(origin.type, 'group');
  const develop = child(origin, 'develop');
  assert.equal(develop.branchName, 'origin/develop');
  assert.equal(develop.type, 'branch');
});

test('all node paths are unique', () => {
  const root = buildBranchTree(SAMPLE);
  const paths = collectPaths(root);
  const set = new Set(paths);
  assert.equal(set.size, paths.length);
  assert.equal(set.size, countNodes(root));
});

test('omits a group with no branches', () => {
  const root = buildBranchTree([{ name: 'main', type: 'local', isHead: true }]);
  const names = root.children.map((g) => g.name);
  assert.deepEqual(names, ['Local']);
});

test('handles empty / non-array input', () => {
  assert.deepEqual(buildBranchTree([]).children, []);
  assert.deepEqual(buildBranchTree(undefined).children, []);
});

test('folders sort before leaves, alphabetical case-insensitive', () => {
  const root = buildBranchTree([
    { name: 'zeta', type: 'local', isHead: false },
    { name: 'Alpha', type: 'local', isHead: false },
    { name: 'feat/x', type: 'local', isHead: false },
  ]);
  const local = child(root, 'Local');
  const order = local.children.map((c) => c.name);
  // 'feat' folder first, then leaves Alpha, zeta (case-insensitive).
  assert.deepEqual(order, ['feat', 'Alpha', 'zeta']);
});

test('buildBranchTree is pure: no DOM references in its body', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../public/branches.js', import.meta.url)),
    'utf8',
  );
  // Extract the buildBranchTree function body (up to the next top-level export).
  const start = src.indexOf('export function buildBranchTree');
  assert.ok(start !== -1, 'buildBranchTree export found');
  const after = src.indexOf('export function mountBranchTree', start);
  const body = src.slice(start, after === -1 ? src.length : after);

  // Strip comments so doc text mentioning "DOM/document/window" is ignored.
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  assert.ok(!/\bdocument\b/.test(code), 'no document reference');
  assert.ok(!/\bwindow\b/.test(code), 'no window reference');
});
