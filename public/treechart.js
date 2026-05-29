'use strict';

/* ----------------------------------------------------------------------------
 * gitly — reusable drill-down node-link tree-chart component (ES module).
 * Zero dependencies, offline, read-only. Custom lightweight inline SVG only —
 * NO charting library, NO external assets.
 *
 * Renders an org-chart-style node-link tree (root at LEFT, depth to the RIGHT,
 * smooth cubic-bezier links) with DRILL-DOWN navigation: a FOCUS node plus a
 * bounded number of descendant LEVELS, and a breadcrumb bar to move back up.
 *
 * Public API:
 *   computeDrilldownLayout(focus, opts)   <- PURE, no DOM, unit-tested
 *   renderTreeChart(container, opts)       <- DOM renderer, manages own state
 * -------------------------------------------------------------------------- */

import { el } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ----------------------------------------------------------------------------
 * PURE LAYOUT — computeDrilldownLayout(focus, opts)
 *
 * MUST NOT touch the DOM / document / window: it is imported and unit-tested in
 * plain Node. Keep it free of any DOM helpers from util.js.
 *
 * Tidy horizontal tree (org-chart style):
 *   - `focus` sits at depth 0 (x = 0). Depth increases to the RIGHT.
 *   - Lays out every descendant down to depth === `levels` (INCLUSIVE). Nodes
 *     deeper than `levels` are NOT laid out. A node AT depth === levels that
 *     itself has children is still INCLUDED (flagged hasChildren:true — it is
 *     drillable) but its children are not placed.
 *   - x = depth * levelGap.
 *   - A displayed LEAF (no displayed children — i.e. a true leaf, OR a node at
 *     depth === levels, OR otherwise collapsed) gets the next sequential
 *     vertical slot: y = (slot++) * rowGap.
 *   - A displayed node WITH displayed children gets y = average(child.y),
 *     computed post-order — centring parents against their children.
 *   - A `seen` Set on path guards against cycles.
 *
 * @param {{name:string,path:string,type:string,children?:Array}} focus
 * @param {{ levels?:number, rowGap?:number, levelGap?:number }} [opts]
 * @returns {{
 *   nodes: Array<{path,name,type,depth,x,y,hasChildren,isLeaf}>,
 *   links: Array<{from:{x,y}, to:{x,y}}>,
 *   width: number,
 *   height: number,
 * }}
 */
export function computeDrilldownLayout(focus, opts = {}) {
  const levels = opts.levels == null ? 2 : opts.levels;
  const rowGap = opts.rowGap == null ? 30 : opts.rowGap;
  const levelGap = opts.levelGap == null ? 200 : opts.levelGap;

  const nodes = [];
  const links = [];

  if (!focus) {
    return { nodes, links, width: 0, height: 0 };
  }

  let slot = 0; // next free vertical slot
  let maxDepth = 0;

  function childrenOf(node) {
    const c = node && node.children;
    if (!c) return [];
    if (typeof c.values === 'function' && !Array.isArray(c)) return [...c.values()];
    return Array.isArray(c) ? c : [];
  }

  // Post-order placement. Returns the laid-out record for `node`.
  function place(node, depth, seen) {
    if (depth > maxDepth) maxDepth = depth;

    const kids = childrenOf(node);
    const hasChildren = kids.length > 0; // drillable if there is data below
    const isLeaf = !hasChildren; // a TRUE leaf has no children at all

    const record = {
      path: node.path,
      name: node.name,
      type: node.type,
      depth,
      x: depth * levelGap,
      y: 0, // set below
      hasChildren,
      isLeaf,
    };

    // Will we display this node's children? Only if it has them AND we have not
    // yet reached the level budget. A node at depth === levels is a displayed
    // leaf even if it has children (it stays drillable via hasChildren).
    const displayChildren = hasChildren && depth < levels;

    if (!displayChildren) {
      record.y = slot * rowGap;
      slot += 1;
      nodes.push(record);
      return record;
    }

    const childRecords = [];
    for (const kid of kids) {
      if (!kid || seen.has(kid.path)) continue; // cycle guard on path
      seen.add(kid.path);
      const cr = place(kid, depth + 1, seen);
      seen.delete(kid.path);
      childRecords.push(cr);
      links.push({
        from: { x: record.x, y: 0 }, // record.y unknown yet; patched below
        to: { x: cr.x, y: cr.y },
        _parent: record,
      });
    }

    if (childRecords.length) {
      let sum = 0;
      for (const cr of childRecords) sum += cr.y;
      record.y = sum / childRecords.length;
    } else {
      // All children were cycle-skipped; treat as a leaf slot.
      record.y = slot * rowGap;
      slot += 1;
    }

    nodes.push(record);
    return record;
  }

  const seen = new Set([focus.path]);
  place(focus, 0, seen);

  // Patch link source y now that every parent y is known.
  for (const link of links) {
    if (link._parent) {
      link.from.y = link._parent.y;
      delete link._parent;
    }
  }

  // Bounds. Allow room to the right for the longest label, plus a little pad.
  const LABEL_ALLOWANCE = 220;
  const PAD = 16;
  let width = maxDepth * levelGap + LABEL_ALLOWANCE;
  let maxY = 0;
  for (const n of nodes) if (n.y > maxY) maxY = n.y;
  let height = maxY + rowGap;

  if (nodes.length) {
    width += PAD;
    height += PAD;
  } else {
    width = 0;
    height = 0;
  }

  return { nodes, links, width, height };
}

/* ----------------------------------------------------------------------------
 * DOM RENDERER — renderTreeChart(container, opts)
 *
 * Manages its own focus + breadcrumb state internally. Safe to call repeatedly
 * on the same container (contents are replaced each render).
 * -------------------------------------------------------------------------- */

const ROW_GAP = 30;
const LEVEL_GAP = 200;
const NODE_RADIUS = 5;
const SVG_MARGIN_X = 24;
const SVG_MARGIN_Y = 20;

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  }
  return node;
}

function childArray(node) {
  const c = node && node.children;
  if (!c) return [];
  if (typeof c.values === 'function' && !Array.isArray(c)) return [...c.values()];
  return Array.isArray(c) ? c : [];
}

/**
 * Find a node by path within `root` (depth-first). Returns the chain of nodes
 * from root → target (inclusive), or null if not found. The chain doubles as
 * the breadcrumb trail.
 */
function findChain(root, path) {
  const stack = [[root, [root]]];
  const seen = new Set();
  while (stack.length) {
    const [node, chain] = stack.pop();
    if (!node || seen.has(node.path)) continue;
    seen.add(node.path);
    if (node.path === path) return chain;
    for (const kid of childArray(node)) {
      stack.push([kid, chain.concat(kid)]);
    }
  }
  return null;
}

/**
 * Mount a reusable drill-down tree chart inside `container`.
 *
 * @param {HTMLElement} container
 * @param {{
 *   root: object,
 *   levels?: number,
 *   onLeaf?: (node)=>void,
 *   labelFor?: (node)=>string,
 *   initialFocusPath?: string,
 *   emptyText?: string,
 * }} [opts]
 */
export function renderTreeChart(container, opts = {}) {
  if (!container) return;

  const root = opts.root || null;
  const levels = opts.levels == null ? 2 : opts.levels;
  const onLeaf = typeof opts.onLeaf === 'function' ? opts.onLeaf : () => {};
  const labelFor =
    typeof opts.labelFor === 'function' ? opts.labelFor : (node) => (node && node.name) || '';
  const emptyText = opts.emptyText || 'Nothing to show.';

  // Internal focus state. Defaults to the absolute root.
  let focusPath = opts.initialFocusPath != null ? opts.initialFocusPath : root ? root.path : '';

  render();

  function render() {
    container.replaceChildren();

    if (!root) {
      const tcRoot = el('div', { className: 'tc-root' });
      tcRoot.append(el('div', { className: 'tc-empty', text: emptyText }));
      container.append(tcRoot);
      return;
    }

    // Resolve the focus node + its ancestor chain (the breadcrumb trail).
    let chain = findChain(root, focusPath);
    if (!chain) {
      // Focus path no longer resolvable — fall back to the absolute root.
      focusPath = root.path;
      chain = [root];
    }
    const focus = chain[chain.length - 1];

    const tcRoot = el('div', { className: 'tc-root' });

    // 1) Breadcrumb bar (root → focus). The last crumb is the current focus.
    tcRoot.append(buildBreadcrumb(chain));

    // If the focus itself has no children, show the empty placeholder in the
    // scroll area (still keep the breadcrumb so the user can navigate up).
    const focusKids = childArray(focus);
    if (focusKids.length === 0) {
      const scroll = el('div', { className: 'tc-scroll' });
      scroll.append(el('div', { className: 'tc-empty', text: emptyText }));
      tcRoot.append(scroll);
      container.append(tcRoot);
      return;
    }

    // 2) Scrollable SVG chart.
    tcRoot.append(buildChart(focus));
    container.append(tcRoot);
  }

  function buildBreadcrumb(chain) {
    const bar = el('div', { className: 'tc-breadcrumb' });
    chain.forEach((node, i) => {
      const isLast = i === chain.length - 1;
      const text = i === 0 ? labelForRoot(node) : labelFor(node);
      if (isLast) {
        // Current focus — non-clickable, emphasized.
        bar.append(el('span', { className: 'tc-crumb is-current', text }));
      } else {
        const crumb = el('span', {
          className: 'tc-crumb',
          text,
          attrs: { role: 'button', tabindex: '0' },
        });
        crumb.addEventListener('click', () => {
          focusPath = node.path;
          render();
        });
        crumb.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            focusPath = node.path;
            render();
          }
        });
        bar.append(crumb);
        bar.append(el('span', { className: 'tc-crumb-sep', text: '/' }));
      }
    });
    return bar;
  }

  function labelForRoot(node) {
    const label = labelFor(node);
    return label && String(label).trim() !== '' ? label : '/';
  }

  function buildChart(focus) {
    const layout = computeDrilldownLayout(focus, {
      levels,
      rowGap: ROW_GAP,
      levelGap: LEVEL_GAP,
    });

    const scroller = el('div', { className: 'tc-scroll' });

    if (!layout.nodes.length) {
      scroller.append(el('div', { className: 'tc-empty', text: emptyText }));
      return scroller;
    }

    const svgW = layout.width + SVG_MARGIN_X * 2;
    const svgH = layout.height + SVG_MARGIN_Y * 2;
    const tx = SVG_MARGIN_X;
    const ty = SVG_MARGIN_Y;

    const svg = svgEl('svg', {
      class: 'tc-svg',
      width: svgW,
      height: svgH,
      viewBox: `0 0 ${svgW} ${svgH}`,
    });

    // Links first so nodes paint on top. Horizontal cubic-bezier S-curves.
    const linkGroup = svgEl('g', { class: 'tc-links' });
    for (const link of layout.links) {
      const x1 = link.from.x + tx;
      const y1 = link.from.y + ty;
      const x2 = link.to.x + tx;
      const y2 = link.to.y + ty;
      const midX = (x1 + x2) / 2;
      const d = `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
      linkGroup.append(svgEl('path', { class: 'tc-link', d }));
    }
    svg.append(linkGroup);

    // Nodes.
    const nodeGroup = svgEl('g', { class: 'tc-nodes' });
    for (const n of layout.nodes) {
      const cx = n.x + tx;
      const cy = n.y + ty;
      // Treat type==='blob' or a true leaf as a file/leaf; everything else is a
      // folder.
      const isLeaf = n.isLeaf || n.type === 'blob';
      const isFolder = !isLeaf;
      const isFocus = n.path === focusPath && n.depth === 0;

      let cls = 'tc-node ' + (isFolder ? 'is-folder' : 'is-leaf');
      if (isFocus) cls += ' selected';

      // Clickable if: a drillable non-focus folder, or a true leaf.
      const drillable = n.hasChildren && !isFocus;
      const clickable = drillable || n.isLeaf;
      if (clickable) cls += ' clickable';

      const g = svgEl('g', { class: cls });
      g.setAttribute('transform', `translate(${cx},${cy})`);

      g.append(svgEl('circle', {
        class: 'tc-circle',
        cx: 0,
        cy: 0,
        r: isFocus ? NODE_RADIUS + 1 : NODE_RADIUS,
      }));

      // Label via textContent — HTML-safe even with untrusted names.
      const label = svgEl('text', {
        class: 'tc-label',
        x: NODE_RADIUS + 8,
        y: 0,
        dy: '0.32em',
      });
      label.textContent = labelFor(n);
      g.append(label);

      // Click handling. Capture the original DATA node for onLeaf.
      if (clickable) {
        const dataNode = resolveDataNode(focus, n);
        g.addEventListener('click', () => {
          if (isFocus) return; // clicking focus/root is a no-op
          if (drillable) {
            focusPath = n.path;
            render();
          } else if (n.isLeaf) {
            onLeaf(dataNode || n);
          }
        });
      }

      nodeGroup.append(g);
    }
    svg.append(nodeGroup);

    scroller.append(svg);
    return scroller;
  }

  // Map a layout record back to its original data node (so onLeaf receives the
  // full node incl. extra fields). Searches within the current focus subtree.
  function resolveDataNode(focus, record) {
    if (record.path === focus.path) return focus;
    const stack = [focus];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || seen.has(node.path)) continue;
      seen.add(node.path);
      if (node.path === record.path) return node;
      for (const kid of childArray(node)) stack.push(kid);
    }
    return null;
  }
}
