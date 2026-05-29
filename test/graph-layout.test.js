'use strict';

/* ----------------------------------------------------------------------------
 * Unit tests for the PURE layout function computeGraphLayout(commits).
 *
 * This imports from ../public/graph.js and runs in plain Node (no DOM). That
 * only works because computeGraphLayout never references document/window — if
 * someone makes it impure, importing it here would crash at module eval / call.
 * -------------------------------------------------------------------------- */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGraphLayout } from '../public/graph.js';

// Helper: build a commit with full-sha-style ids.
function c(sha, parents, extra = {}) {
  return { sha, shortSha: sha.slice(0, 7), parents, subject: sha, refs: [], ...extra };
}

test('linear history → single column, all vertical edges', () => {
  // newest first: D -> C -> B -> A (root)
  const commits = [
    c('D', ['C']),
    c('C', ['B']),
    c('B', ['A']),
    c('A', []),
  ];
  const { rows, laneCount } = computeGraphLayout(commits);

  assert.equal(rows.length, 4);
  assert.equal(laneCount, 1, 'linear history uses exactly one lane');

  for (const row of rows) {
    assert.equal(row.col, 0, `${row.sha} should be in column 0`);
  }
  // Every edge is vertical (fromCol === toCol).
  for (const row of rows) {
    for (const e of row.edges) {
      assert.equal(e.fromCol, e.toCol, `${row.sha} edge should be vertical`);
    }
  }
  // The root commit emits no downward edges.
  assert.equal(rows[3].sha, 'A');
  assert.equal(rows[3].edges.length, 0, 'root commit has no downward edges');
});

test('merge history → multiple lanes and a real branch/merge connector', () => {
  // DAG (newest first):
  //   M  parents [A, B]   (merge tip)
  //   A  parents [base]
  //   B  parents [base]
  //   base  parents []    (root)
  const commits = [
    c('M', ['A', 'B']),
    c('A', ['base']),
    c('B', ['base']),
    c('base', []),
  ];
  const { rows, laneCount } = computeGraphLayout(commits);

  assert.equal(rows.length, 4);
  assert.ok(laneCount >= 2, `expected >=2 lanes around the merge, got ${laneCount}`);

  const byId = Object.fromEntries(rows.map((r) => [r.sha, r]));

  // M (the merge) must have edges to two distinct columns.
  const mTargets = new Set(byId.M.edges.map((e) => e.toCol));
  assert.ok(mTargets.size >= 2, 'merge commit M must connect to two columns');

  // Somewhere in the graph there is a non-vertical connector (branch/merge).
  const hasDiagonal = rows.some((r) => r.edges.some((e) => e.fromCol !== e.toCol));
  assert.ok(hasDiagonal, 'expected at least one curved (fromCol!==toCol) connector');

  // base is the root → no downward edges.
  assert.equal(byId.base.edges.length, 0);

  // Every edge carries a color.
  for (const r of rows) {
    for (const e of r.edges) {
      assert.equal(typeof e.color, 'string');
      assert.ok(e.color.length > 0);
    }
  }
});

test('octopus merge (>2 parents) does not crash and fans out', () => {
  const commits = [
    c('O', ['A', 'B', 'C']),
    c('A', ['base']),
    c('B', ['base']),
    c('C', ['base']),
    c('base', []),
  ];
  const { rows, laneCount } = computeGraphLayout(commits);
  const o = rows.find((r) => r.sha === 'O');
  const targets = new Set(o.edges.map((e) => e.toCol));
  assert.ok(targets.size >= 3, `octopus should connect to >=3 columns, got ${targets.size}`);
  assert.ok(laneCount >= 3);
});

test('parent outside the loaded window does not crash', () => {
  // Only X is loaded; its parent "missing" is not present.
  const commits = [c('X', ['missing'])];
  const { rows, laneCount } = computeGraphLayout(commits);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].col, 0);
  assert.equal(laneCount, 1);
  // Edge heads straight down (to its own column) and stops.
  for (const e of rows[0].edges) {
    assert.equal(typeof e.fromCol, 'number');
    assert.equal(typeof e.toCol, 'number');
  }
});

test('root commit alone → no downward edges, no crash', () => {
  const { rows, laneCount } = computeGraphLayout([c('R', [])]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].col, 0);
  assert.equal(rows[0].edges.length, 0);
  assert.equal(laneCount, 1);
});

test('empty input → empty layout', () => {
  const { rows, laneCount } = computeGraphLayout([]);
  assert.equal(rows.length, 0);
  assert.equal(laneCount, 0);
});
