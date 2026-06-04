'use strict';

/* ----------------------------------------------------------------------------
 * gitly — Repo Tree tab (ES module). Zero dependencies, offline, read-only.
 *
 * Owns a two-pane layout inside the host element:
 *   - left  "tree" pane:   the folder/file hierarchy drawn by the shared
 *                          drill-down node-link tree-chart component
 *                          (./treechart.js). No charting library, no assets.
 *   - right "viewer" pane: file contents with a line-number gutter.
 *
 * Built from a flat list of paths returned by /api/tree, assembled into a
 * nested node tree the shared component understands. File content is fetched
 * lazily, only when a TRUE LEAF (file) is clicked.
 *
 * Public API:
 *   mountRepoTree(rootEl, opts = {})
 * -------------------------------------------------------------------------- */

import { el, setPlaceholder, fetchJson, showError, clearError, renderCodeWithGutter } from './util.js';
import { renderTreeChart } from './treechart.js';

/**
 * Mount the Repo Tree tab inside `rootEl`. Safe to call repeatedly — the host
 * element is cleared and rebuilt cleanly each time.
 *
 * @param {HTMLElement} rootEl  Container that fills the tab panel.
 * @param {{ ref?: string }} [opts]
 */
export function mountRepoTree(rootEl, opts = {}) {
  if (!rootEl) return;
  const ref = opts.ref || 'HEAD';

  // Clean slate — supports re-mounting.
  rootEl.replaceChildren();
  clearError();

  // Two-pane layout: left = tree-chart host, right = file viewer.
  const layout = el('div', { className: 'tree-layout' });
  const chartHost = el('div', { className: 'tree-pane' });
  const viewer = el('div', { className: 'fileview-pane' });
  layout.append(chartHost, viewer);
  rootEl.append(layout);

  setPlaceholder(chartHost, 'Loading…');
  setPlaceholder(viewer, 'Select a file');

  load();

  async function load() {
    try {
      const entries = await fetchJson('/api/tree?ref=' + encodeURIComponent(ref));
      clearError();
      const root = buildTree(Array.isArray(entries) ? entries : []);
      chartHost.replaceChildren();
      renderTreeChart(chartHost, {
        root,
        levels: 2,
        onLeaf: (node) => openFile(node.path),
        emptyText: 'Empty repository',
      });
    } catch (err) {
      showError(err && err.message ? err.message : 'Failed to load repo tree.');
      setPlaceholder(chartHost, 'Unable to load tree.');
    }
  }

  /* ---- Tree model -------------------------------------------------------- */

  // Build a nested root node from flat paths. Each node:
  //   { name, path, type:'tree'|'blob'|'commit', size?, children?:Array }
  // Intermediate folders are synthesized when only deeper paths are present.
  // Children are sorted folders-first, then alphabetical (case-insensitive).
  function buildTree(entries) {
    const root = { name: '/', path: '', type: 'tree', children: new Map() };

    for (const entry of entries) {
      if (!entry || typeof entry.path !== 'string') continue;
      const parts = entry.path.split('/').filter(Boolean);
      if (parts.length === 0) continue;

      let node = root;
      let acc = '';
      for (let i = 0; i < parts.length; i++) {
        const name = parts[i];
        acc = acc ? acc + '/' + name : name;
        const isLeaf = i === parts.length - 1;

        let child = node.children.get(name);
        if (!child) {
          child = {
            name,
            path: acc,
            type: isLeaf ? (entry.type || 'blob') : 'tree',
            children: new Map(),
          };
          if (isLeaf && entry.size != null) child.size = entry.size;
          node.children.set(name, child);
        } else if (isLeaf) {
          if (child.children.size === 0) {
            child.type = entry.type || child.type;
            if (entry.size != null) child.size = entry.size;
          }
        }
        node = child;
      }
    }

    return finalize(root);
  }

  // Convert the Map-based scaffold into sorted children arrays. Folders sort
  // before files; ties broken alphabetically (case-insensitive).
  function finalize(node) {
    const kids = [...node.children.values()];
    kids.sort((a, b) => {
      const aDir = a.type === 'tree';
      const bDir = b.type === 'tree';
      if (aDir !== bDir) return aDir ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
    });
    const out = { name: node.name, path: node.path, type: node.type };
    if (node.size != null) out.size = node.size;
    if (kids.length || node.type === 'tree') {
      out.children = kids.map(finalize);
    }
    return out;
  }

  /* ---- File viewing ------------------------------------------------------ */

  async function openFile(path) {
    setPlaceholder(viewer, 'Loading…');
    try {
      const data = await fetchJson(
        '/api/file?ref=' + encodeURIComponent(ref) + '&path=' + encodeURIComponent(path)
      );
      clearError();
      renderFileContents(data || {}, path);
    } catch (err) {
      showError(err && err.message ? err.message : 'Failed to load file.');
      setPlaceholder(viewer, 'Unable to load file.');
    }
  }

  function renderFileContents(data, fallbackPath) {
    const path = data.path || fallbackPath || '';
    const viewerInner = el('div', { className: 'fileview-inner' });

    // Header: monospace path + size.
    const header = el('div', { className: 'fileview-header' });
    header.append(el('span', { className: 'fileview-path mono', text: path }));
    if (data.size != null) {
      header.append(el('span', { className: 'fileview-size', text: formatSize(data.size) }));
    }
    viewerInner.append(header);

    if (data.truncated) {
      viewerInner.append(el('div', { className: 'fileview-note', text: '(truncated)' }));
    }

    if (data.binary) {
      viewerInner.append(
        el('div', { className: 'fileview-binary', text: 'binary file — not shown' })
      );
      viewer.replaceChildren(viewerInner);
      return;
    }

    viewerInner.append(renderCodeWithGutter(data.content));
    viewer.replaceChildren(viewerInner);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
}
