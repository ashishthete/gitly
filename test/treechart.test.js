'use strict';

/* ----------------------------------------------------------------------------
 * Unit tests for the PURE layout function computeDrilldownLayout(focus, opts).
 *
 * Imports from ../public/treechart.js and runs in plain Node (no DOM). That
 * only works because computeDrilldownLayout never references document/window —
 * if someone makes it impure, importing/calling it here would crash.
 * -------------------------------------------------------------------------- */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDrilldownLayout } from '../public/treechart.js';

const ROW_GAP = 30;
const LEVEL_GAP = 200;
const OPTS = { levels: 2, rowGap: ROW_GAP, levelGap: LEVEL_GAP };

// Synthetic nested tree:
//   root
//   ├─ A         (tree)
//   │   ├─ A1    (tree)
//   │   │   └─ A1a  (blob)   <- depth 3 under root
//   │   └─ A2    (blob)
//   └─ B         (blob)
function makeTree() {
  const A1a = { name: 'A1a', path: 'A/A1/A1a', type: 'blob', children: [] };
  const A1 = { name: 'A1', path: 'A/A1', type: 'tree', children: [A1a] };
  const A2 = { name: 'A2', path: 'A/A2', type: 'blob', children: [] };
  const A = { name: 'A', path: 'A', type: 'tree', children: [A1, A2] };
  const B = { name: 'B', path: 'B', type: 'blob', children: [] };
  const root = { name: 'root', path: '', type: 'tree', children: [A, B] };
  return { root, A, A1, A2, A1a, B };
}

function byPath(layout) {
  const m = new Map();
  for (const n of layout.nodes) m.set(n.path, n);
  return m;
}

test('levels=2 from root: depths 0,1,2 present; depth 3 (A1a) excluded', () => {
  const { root } = makeTree();
  const layout = computeDrilldownLayout(root, OPTS);
  const m = byPath(layout);

  assert.ok(m.has(''), 'root (depth 0) present');
  assert.ok(m.has('A'), 'A (depth 1) present');
  assert.ok(m.has('B'), 'B (depth 1) present');
  assert.ok(m.has('A/A1'), 'A1 (depth 2) present');
  assert.ok(m.has('A/A2'), 'A2 (depth 2) present');
  assert.equal(m.has('A/A1/A1a'), false, 'A1a (depth 3) must be excluded');

  assert.equal(m.get('').depth, 0);
  assert.equal(m.get('A').depth, 1);
  assert.equal(m.get('A/A1').depth, 2);
});

test('A1 at depth===levels with a child is included and hasChildren===true', () => {
  const { root } = makeTree();
  const layout = computeDrilldownLayout(root, OPTS);
  const a1 = byPath(layout).get('A/A1');
  assert.ok(a1, 'A1 included even at the level boundary');
  assert.equal(a1.depth, 2);
  assert.equal(a1.hasChildren, true, 'A1 is drillable (has a child in data)');
  assert.equal(a1.isLeaf, false, 'A1 is not a true leaf');
});

test('x === depth * levelGap for sampled nodes', () => {
  const { root } = makeTree();
  const layout = computeDrilldownLayout(root, OPTS);
  for (const n of layout.nodes) {
    assert.equal(n.x, n.depth * LEVEL_GAP, `${n.path || '<root>'} x = depth*levelGap`);
  }
});

test('parent with 2 displayed children has y === average(children y)', () => {
  const { root } = makeTree();
  const layout = computeDrilldownLayout(root, OPTS);
  const m = byPath(layout);

  // A has 2 displayed children: A1, A2.
  const A = m.get('A');
  const A1 = m.get('A/A1');
  const A2 = m.get('A/A2');
  assert.equal(A.y, (A1.y + A2.y) / 2, 'A.y should be avg of A1,A2');

  // root has 2 displayed children: A, B.
  const r = m.get('');
  const B = m.get('B');
  assert.equal(r.y, (A.y + B.y) / 2, 'root.y should be avg of A,B');
});

test('displayed leaves get distinct sequential y spaced by rowGap', () => {
  const { root } = makeTree();
  const layout = computeDrilldownLayout(root, OPTS);
  const m = byPath(layout);

  // Displayed leaves (no displayed children): A1 (at level boundary), A2, B.
  const A1 = m.get('A/A1');
  const A2 = m.get('A/A2');
  const B = m.get('B');

  const ys = [A1.y, A2.y, B.y].slice().sort((p, q) => p - q);
  assert.equal(new Set(ys).size, 3, 'all displayed leaves occupy distinct slots');
  for (let i = 0; i < ys.length; i++) {
    assert.equal(ys[i], i * ROW_GAP, `leaf slot ${i} should be ${i} * rowGap`);
  }
});

test('childless node isLeaf===true; node with children hasChildren===true', () => {
  const { root } = makeTree();
  const layout = computeDrilldownLayout(root, OPTS);
  const m = byPath(layout);

  const B = m.get('B'); // truly childless
  assert.equal(B.isLeaf, true);
  assert.equal(B.hasChildren, false);

  const A = m.get('A'); // has children
  assert.equal(A.hasChildren, true);
  assert.equal(A.isLeaf, false);
});

test('links connect parent y to child positions', () => {
  const { root } = makeTree();
  const layout = computeDrilldownLayout(root, OPTS);
  const m = byPath(layout);
  const A = m.get('A');
  const link = layout.links.find((l) => l.to.x === A.x && l.to.y === A.y);
  assert.ok(link, 'a link should target node A');
  const r = m.get('');
  assert.equal(link.from.y, r.y, 'link source y === parent (root) y');
  assert.equal(link.from.x, r.x);
});

test('empty / childless focus → no crash', () => {
  assert.deepEqual(computeDrilldownLayout(null, OPTS), {
    nodes: [],
    links: [],
    width: 0,
    height: 0,
  });

  const lone = { name: 'x', path: 'x', type: 'tree', children: [] };
  const layout = computeDrilldownLayout(lone, OPTS);
  assert.equal(layout.nodes.length, 1);
  assert.equal(layout.nodes[0].x, 0);
  assert.equal(layout.nodes[0].y, 0);
  assert.equal(layout.nodes[0].depth, 0);
  assert.equal(layout.nodes[0].isLeaf, true);
  assert.equal(layout.links.length, 0);
});

test('missing children property is tolerated', () => {
  const node = { name: 'n', path: 'n', type: 'tree' }; // no children key
  const layout = computeDrilldownLayout(node, OPTS);
  assert.equal(layout.nodes.length, 1);
  assert.equal(layout.nodes[0].isLeaf, true);
  assert.equal(layout.nodes[0].hasChildren, false);
});

test('cycle guard: self-referential children terminate', () => {
  const cyclic = { name: 'x', path: 'x', type: 'tree', children: [] };
  cyclic.children.push(cyclic);
  const layout = computeDrilldownLayout(cyclic, OPTS);
  assert.ok(layout.nodes.length >= 1);
  assert.ok(Number.isFinite(layout.height));
});
