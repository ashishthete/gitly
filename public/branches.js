'use strict';

/* ----------------------------------------------------------------------------
 * gitly — Branches tree (ES module). Zero dependencies, offline, read-only.
 *
 * Builds a drill-down node-link tree of git branches grouped by their
 * '/'-separated names, split into Local and Remote groups, and mounts it via
 * the shared treechart component.
 *
 * Public API:
 *   buildBranchTree(branches)            <- PURE, no DOM, unit-tested
 *   mountBranchTree(rootEl, opts)        <- DOM mount via renderTreeChart
 * -------------------------------------------------------------------------- */

import { renderTreeChart } from './treechart.js';

/**
 * Build the nested root node for the branches tree.
 *
 * PURE: no DOM / document / window references.
 *
 * @param {Array<{name:string,type:'local'|'remote',isHead:boolean}>} branches
 * @returns {{name:'branches',path:'',type:'group',children:Array}}
 */
export function buildBranchTree(branches) {
  const list = Array.isArray(branches) ? branches : [];

  const groupDefs = [
    { key: 'local', label: 'Local', type: 'local' },
    { key: 'remote', label: 'Remote', type: 'remote' },
  ];

  const groups = [];

  for (const def of groupDefs) {
    const members = list.filter((b) => b && b.type === def.type);
    if (members.length === 0) continue;

    // Root folder for this group. `byPath` maps a node's path -> node so we can
    // reuse intermediate folder nodes across branches that share a prefix.
    const groupRoot = {
      name: def.label,
      path: def.key,
      type: 'group',
      children: [],
    };
    const byPath = new Map([[groupRoot.path, groupRoot]]);

    for (const branch of members) {
      const fullName = String(branch.name);
      const segments = fullName.split('/');

      let parent = groupRoot;
      let prefix = def.key;

      // All but the last segment become folder nodes (reused if present).
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        prefix += '/' + seg;
        let folder = byPath.get(prefix);
        if (!folder) {
          folder = { name: seg, path: prefix, type: 'group', children: [] };
          byPath.set(prefix, folder);
          parent.children.push(folder);
        }
        parent = folder;
      }

      // Final segment is the leaf branch node. Path keyed on the FULL branch
      // name (within the group) so it is unique even across nested folders.
      const leaf = {
        name: segments[segments.length - 1],
        path: def.key + '/' + fullName,
        type: 'branch',
        branchName: fullName,
        isHead: !!branch.isHead,
        branchType: branch.type,
      };
      parent.children.push(leaf);
    }

    sortTree(groupRoot);
    groups.push(groupRoot);
  }

  return {
    name: 'branches',
    path: '',
    type: 'group',
    children: groups,
  };
}

/** Recursively sort children: folders before leaves, alphabetical (ci) within. */
function sortTree(node) {
  if (!node || !Array.isArray(node.children)) return;
  node.children.sort((a, b) => {
    const aFolder = Array.isArray(a.children);
    const bFolder = Array.isArray(b.children);
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  for (const child of node.children) {
    if (Array.isArray(child.children)) sortTree(child);
  }
}

/**
 * Label for a node in the tree chart. Plain text (inserted via textContent).
 *
 * @param {object} node
 * @returns {string}
 */
function labelFor(node) {
  if (!node) return '';
  if (node.type === 'branch') {
    return node.isHead ? node.name + '  ● HEAD' : node.name;
  }
  return node.name;
}

/**
 * Mount the branches tree into `rootEl`. Safe to re-mount (renderTreeChart
 * clears the container).
 *
 * @param {HTMLElement} rootEl
 * @param {{branches:Array, onSelectBranch:(name:string)=>void}} opts
 */
export function mountBranchTree(rootEl, opts = {}) {
  const branches = opts.branches;
  const onSelectBranch =
    typeof opts.onSelectBranch === 'function' ? opts.onSelectBranch : () => {};

  const root = buildBranchTree(branches);

  renderTreeChart(rootEl, {
    root,
    levels: 2,
    onLeaf: (node) => onSelectBranch(node.branchName),
    labelFor,
    emptyText: 'No branches',
  });
}
