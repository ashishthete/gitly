'use strict';

/* ----------------------------------------------------------------------------
 * Meld — commit-graph (branch DAG) renderer (ES module, zero dependencies).
 *
 * Renders one clickable row per commit. Each row has a LEFT graph gutter drawn
 * with inline SVG (continuous lanes + node + branch/merge curves) and commit
 * info on the RIGHT (subject, meta, and optional ref badges).
 *
 * Public API:
 *   computeGraphLayout(commits)   <- PURE, no DOM, unit-tested
 *   renderCommitGraph(container, commits, opts = {})
 *   highlightCommit(container, sha)
 * -------------------------------------------------------------------------- */

import { el, cssEscape } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const ROW_HEIGHT = 64; // px per commit row (fits subject + meta + stats lines)
const LANE_WIDTH = 16; // px horizontal spacing between lanes
const NODE_RADIUS = 4; // px
const STROKE_WIDTH = 2; // px
const GUTTER_PAD = 8; // px left padding inside the gutter

// Stable lane colors cycled by lane (color) index.
const LANE_COLORS = [
  '#4eb4f7', // blue
  '#56d364', // green
  '#d2a8ff', // purple
  '#f0883e', // orange
  '#f778ba', // pink
  '#e3b341', // yellow
  '#39c5cf', // teal
  '#ff7b72', // red
];

function laneColor(index) {
  const n = LANE_COLORS.length;
  return LANE_COLORS[((index % n) + n) % n];
}

// X center position of a lane column inside the gutter.
function laneX(col) {
  return GUTTER_PAD + col * LANE_WIDTH + LANE_WIDTH / 2;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  }
  return node;
}

/* ----------------------------------------------------------------------------
 * PURE LAYOUT — computeGraphLayout(commits)
 *
 * MUST NOT touch the DOM / document / window: it is imported and unit-tested in
 * plain Node.
 *
 * Process commits top-to-bottom (newest first). `lanes` is an ordered array of
 * "expected sha" values — the sha each column is currently waiting to draw
 * (null === free slot, pending compaction). A stable `color` travels with each
 * lane so a branch keeps its hue even when it shifts columns after compaction.
 *
 * For each commit:
 *   - col = first lane expecting this commit's sha; else a new lane (branch tip).
 *   - The lane is reassigned to the commit's FIRST parent (the line continues).
 *   - Each ADDITIONAL parent reuses a lane already expecting it, else opens a
 *     new lane (a MERGE → edges fan out to multiple columns; >2 = octopus).
 *   - Root commits (no parents) free the lane.
 *   - Parents not present in the loaded window still get an edge heading down
 *     (they simply terminate at their assigned lane; never crash).
 *   - Freed lanes are compacted away; surviving lanes shift left, and the
 *     col->col remap feeds the downward "through"/move edges.
 *
 * Returns:
 *   {
 *     rows: [ { sha, col, color, edges:[{ fromCol, toCol, color }] } ],  // 1:1 w/ commits
 *     laneCount: <max simultaneous lanes>
 *   }
 * `edges` are the connectors leaving THIS row downward toward the next row:
 * straight vertical when fromCol===toCol, a curve when they differ.
 * -------------------------------------------------------------------------- */
export function computeGraphLayout(commits) {
  const list = Array.isArray(commits) ? commits : [];

  // Lane object: { sha: expectedSha|null, color: colorIndex }.
  let lanes = [];
  let nextColor = 0;
  const rows = [];
  let laneCount = 0;

  const freeLane = () => lanes.findIndex((l) => l.sha === null);

  for (const commit of list) {
    const parents = Array.isArray(commit.parents) ? commit.parents.filter(Boolean) : [];

    // 1) Find / allocate this commit's lane.
    let col = lanes.findIndex((l) => l.sha === commit.sha);
    if (col === -1) {
      const f = freeLane();
      if (f === -1) {
        col = lanes.length;
        lanes.push({ sha: commit.sha, color: nextColor++ });
      } else {
        col = f;
        lanes[col] = { sha: commit.sha, color: nextColor++ };
      }
    }
    const nodeColor = lanes[col].color;

    // Any OTHER lanes also expecting this sha collapse onto this commit's node
    // (multiple children of the same commit converge). They are freed here so
    // they don't survive as phantom pass-throughs.
    for (let i = 0; i < lanes.length; i++) {
      if (i !== col && lanes[i].sha === commit.sha) {
        lanes[i] = { sha: null, color: lanes[i].color };
      }
    }

    // 2) Reassign / open lanes for parents.
    if (parents.length === 0) {
      // Root commit: lane terminates here.
      lanes[col] = { sha: null, color: lanes[col].color };
    } else {
      // First parent continues the commit's own lane (keeps its color).
      lanes[col] = { sha: parents[0], color: lanes[col].color };
      // Additional parents → merges. Reuse a lane expecting the parent, else
      // open a fresh lane with a new color.
      for (let p = 1; p < parents.length; p++) {
        const par = parents[p];
        let pCol = lanes.findIndex((l) => l.sha === par);
        if (pCol === -1) {
          const f = freeLane();
          if (f === -1) {
            lanes.push({ sha: par, color: nextColor++ });
          } else {
            lanes[f] = { sha: par, color: nextColor++ };
          }
        }
      }
    }

    // 3) Edges from THIS row down to the next, computed against the post-assign
    //    lane array but BEFORE compaction; then remapped to compacted columns.
    //    a) the commit's edges to each distinct parent lane,
    //    b) pass-through edges for every other lane that survives.
    const preLanes = lanes.slice();

    // Compact: drop empties; survivors shift left. Build old->new remap.
    const compacted = [];
    const remap = new Map();
    for (let i = 0; i < preLanes.length; i++) {
      if (preLanes[i].sha === null) continue;
      remap.set(i, compacted.length);
      compacted.push(preLanes[i]);
    }
    lanes = compacted;

    const edges = [];
    const seen = new Set();
    const pushEdge = (fromCol, toCol, color) => {
      const key = fromCol + '>' + toCol;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ fromCol, toCol, color });
    };

    if (parents.length === 0) {
      // No downward edges from a root commit.
    } else {
      // Commit's own lane → first-parent column.
      const ownTo = remap.has(col) ? remap.get(col) : col;
      pushEdge(col, ownTo, laneColor(nodeColor));
      // Each additional parent → its (compacted) column.
      for (let p = 1; p < parents.length; p++) {
        const par = parents[p];
        const preCol = preLanes.findIndex((l) => l.sha === par);
        const toCol = preCol === -1 ? col : (remap.has(preCol) ? remap.get(preCol) : preCol);
        const color = preCol === -1 ? laneColor(nodeColor) : laneColor(preLanes[preCol].color);
        pushEdge(col, toCol, color);
      }
    }

    // Pass-through / move edges for all OTHER surviving lanes.
    for (let i = 0; i < preLanes.length; i++) {
      if (i === col) continue; // commit's own lane handled above
      if (!remap.has(i)) continue; // consumed this row
      const toCol = remap.get(i);
      pushEdge(i, toCol, laneColor(preLanes[i].color));
    }

    rows.push({ sha: commit.sha, col, color: laneColor(nodeColor), edges });

    laneCount = Math.max(laneCount, preLanes.length, lanes.length, col + 1);
  }

  return { rows, laneCount };
}

/* ----------------------------------------------------------------------------
 * Rendering (DOM)
 * -------------------------------------------------------------------------- */

/* Build the continuous-lane SVG gutter for a single row.
 *
 * Each row's SVG is exactly ROW_HEIGHT tall. For every edge leaving this row we
 * draw from the source column at mid-row DOWN to the target column at the row
 * bottom; the matching edge in the row below carries the line from its top to
 * its own mid. Because adjacent rows share column coordinates, lanes that pass
 * straight through stay unbroken top-to-bottom, while branch/merge edges curve
 * smoothly from one column to another.
 */
function buildGutter(row, gutterWidth) {
  const svg = svgEl('svg', {
    class: 'graph-gutter-svg',
    width: gutterWidth,
    height: ROW_HEIGHT,
    viewBox: `0 0 ${gutterWidth} ${ROW_HEIGHT}`,
  });

  const mid = ROW_HEIGHT / 2;
  const nodeX = laneX(row.col);

  for (const edge of row.edges) {
    const fromX = laneX(edge.fromCol);
    const toX = laneX(edge.toCol);
    // Top half: bring the source lane from y=0 down to mid (keeps the column
    // continuous with the row above). The commit's own lane top half is the
    // line entering its node.
    const top = svgEl('path', {
      d: `M ${fromX} 0 L ${fromX} ${mid}`,
      class: 'graph-edge',
      stroke: edge.color,
      'stroke-width': STROKE_WIDTH,
      fill: 'none',
    });
    svg.appendChild(top);

    // Bottom half: mid -> next row's column (vertical or smooth cubic curve).
    let d;
    if (fromX === toX) {
      d = `M ${fromX} ${mid} L ${toX} ${ROW_HEIGHT}`;
    } else {
      const cy = mid + (ROW_HEIGHT - mid) / 2;
      d = `M ${fromX} ${mid} C ${fromX} ${cy}, ${toX} ${mid + (ROW_HEIGHT - mid) / 2}, ${toX} ${ROW_HEIGHT}`;
    }
    const bottom = svgEl('path', {
      d,
      class: 'graph-edge',
      stroke: edge.color,
      'stroke-width': STROKE_WIDTH,
      fill: 'none',
    });
    svg.appendChild(bottom);
  }

  // Ensure the commit's own lane has a top segment even when it has no edges
  // (e.g. a root commit whose lane terminates here).
  if (row.edges.length === 0) {
    const top = svgEl('path', {
      d: `M ${nodeX} 0 L ${nodeX} ${mid}`,
      class: 'graph-edge',
      stroke: row.color,
      'stroke-width': STROKE_WIDTH,
      fill: 'none',
    });
    svg.appendChild(top);
  }

  // Node circle on top of everything.
  const circle = svgEl('circle', {
    cx: nodeX,
    cy: mid,
    r: NODE_RADIUS,
    class: 'graph-node',
    fill: row.color,
  });
  svg.appendChild(circle);

  return svg;
}

/* Classify a ref string into a type for badge styling.
 *   starts with 'tag:'              -> tag (yellowish)
 *   contains 'HEAD ->' or no slash  -> local/head (greenish)
 *   contains '/'                    -> remote (bluish)
 */
function refType(ref) {
  const r = String(ref).trim();
  if (/^tag:/.test(r)) return 'tag';
  if (r.includes('HEAD ->')) return 'head';
  if (r.includes('/')) return 'remote';
  return 'head';
}

function refLabel(ref) {
  return String(ref).replace(/^tag:\s*/, '').trim();
}

function buildRefs(refs) {
  const wrap = el('span', { className: 'graph-refs' });
  for (const ref of refs) {
    if (ref == null || String(ref).trim() === '') continue;
    const type = refType(ref);
    const badge = el('span', {
      className: 'graph-ref graph-ref-' + type,
      text: refLabel(ref),
    });
    wrap.appendChild(badge);
  }
  return wrap;
}

function buildInfo(commit, showRefs) {
  const info = el('div', { className: 'graph-info' });

  const subject = el('div', {
    className: 'graph-subject',
    text: commit.subject || '',
  });

  if (showRefs && Array.isArray(commit.refs) && commit.refs.length > 0) {
    subject.prepend(buildRefs(commit.refs));
  }
  info.appendChild(subject);

  const meta = el('div', { className: 'graph-meta' });
  const shaSpan = el('span', {
    className: 'graph-sha',
    text: commit.shortSha || (commit.sha ? commit.sha.slice(0, 7) : ''),
  });
  meta.appendChild(shaSpan);
  if (commit.author) {
    meta.appendChild(el('span', { className: 'graph-meta-sep', text: ' · ' }));
    meta.appendChild(el('span', { className: 'graph-author', text: commit.author }));
  }
  if (commit.dateRelative) {
    meta.appendChild(el('span', { className: 'graph-meta-sep', text: ' · ' }));
    meta.appendChild(el('span', { className: 'graph-date', text: commit.dateRelative }));
  }
  info.appendChild(meta);

  const stats = buildStats(commit.stats);
  if (stats) info.appendChild(stats);

  return info;
}

/* Compact per-commit change summary: line +/- and file A/M/D counts.
 * Returns null when there are no stats to show (e.g. merge commits). */
function buildStats(s) {
  if (!s) return null;
  const linesAdded = s.linesAdded || 0;
  const linesRemoved = s.linesRemoved || 0;
  const filesAdded = s.filesAdded || 0;
  const filesModified = s.filesModified || 0;
  const filesRemoved = s.filesRemoved || 0;

  if (
    linesAdded === 0 && linesRemoved === 0 &&
    filesAdded === 0 && filesModified === 0 && filesRemoved === 0
  ) {
    return null;
  }

  const wrap = el('div', { className: 'graph-stats' });

  if (linesAdded > 0 || linesRemoved > 0) {
    const lines = el('span', { className: 'graph-stat-lines' });
    if (linesAdded > 0) {
      lines.appendChild(el('span', { className: 'graph-stat-add', text: '+' + linesAdded }));
    }
    if (linesRemoved > 0) {
      lines.appendChild(el('span', { className: 'graph-stat-del', text: '−' + linesRemoved }));
    }
    wrap.appendChild(lines);
  }

  const fileTokens = [];
  if (filesAdded > 0) fileTokens.push(['A', filesAdded, 'A']);
  if (filesModified > 0) fileTokens.push(['M', filesModified, 'M']);
  if (filesRemoved > 0) fileTokens.push(['D', filesRemoved, 'D']);

  if (fileTokens.length > 0) {
    const files = el('span', { className: 'graph-stat-files' });
    const totalFiles = filesAdded + filesModified + filesRemoved;
    files.setAttribute(
      'title',
      `${totalFiles} file${totalFiles === 1 ? '' : 's'} changed` +
        (filesAdded ? ` · ${filesAdded} added` : '') +
        (filesModified ? ` · ${filesModified} modified` : '') +
        (filesRemoved ? ` · ${filesRemoved} removed` : '')
    );
    for (const [code, count] of fileTokens) {
      const tok = el('span', { className: 'graph-fstat graph-fstat-' + code });
      tok.appendChild(el('span', { className: 'graph-fstat-n', text: String(count) }));
      tok.appendChild(el('span', { className: 'graph-fstat-c', text: code }));
      files.appendChild(tok);
    }
    wrap.appendChild(files);
  }

  return wrap;
}

/**
 * Render a commit graph into `container`, clearing it first.
 *
 * @param {HTMLElement} container
 * @param {Array<{sha,shortSha,parents,author,dateRelative,subject,refs}>} commits
 *        Topological order, newest first.
 * @param {{selectedSha?:string, onSelect?:(sha:string)=>void, showRefs?:boolean}} [opts]
 */
export function renderCommitGraph(container, commits, opts = {}) {
  if (!container) return;
  const list = Array.isArray(commits) ? commits : [];
  const { selectedSha, onSelect, showRefs = false } = opts;

  container.replaceChildren();

  if (list.length === 0) {
    container.appendChild(el('div', { className: 'placeholder', text: 'No commits to display.' }));
    return;
  }

  const { rows, laneCount } = computeGraphLayout(list);
  const gutterWidth = GUTTER_PAD * 2 + Math.max(1, laneCount) * LANE_WIDTH;

  const frag = document.createDocumentFragment();

  for (let i = 0; i < list.length; i++) {
    const commit = list[i];
    const row = rows[i];

    const rowEl = el('div', {
      className: 'graph-row',
      attrs: { 'data-sha': commit.sha, role: 'button', tabindex: '0' },
    });
    if (selectedSha && commit.sha === selectedSha) {
      rowEl.classList.add('selected');
    }

    const gutter = el('div', { className: 'graph-gutter' });
    gutter.style.width = gutterWidth + 'px';
    gutter.style.minWidth = gutterWidth + 'px';
    gutter.appendChild(buildGutter(row, gutterWidth));
    rowEl.appendChild(gutter);

    rowEl.appendChild(buildInfo(commit, showRefs));

    if (typeof onSelect === 'function') {
      rowEl.addEventListener('click', () => onSelect(commit.sha));
      rowEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(commit.sha);
        }
      });
    }

    frag.appendChild(rowEl);
  }

  container.appendChild(frag);
}

/**
 * Move the `.selected` class to the row matching `sha` without re-rendering.
 *
 * @param {HTMLElement} container
 * @param {string} sha
 */
export function highlightCommit(container, sha) {
  if (!container) return;
  const prev = container.querySelector('.graph-row.selected');
  if (prev) prev.classList.remove('selected');
  if (sha == null) return;
  const next = container.querySelector(`.graph-row[data-sha="${cssEscape(sha)}"]`);
  if (next) next.classList.add('selected');
}
