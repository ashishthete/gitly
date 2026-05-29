/* ----------------------------------------------------------------------------
 * gitly — read-only git viewer (frontend shell, ES module)
 *
 * Owns the tab bar and three views:
 *   - History    (branches | commit graph | detail)
 *   - Full Graph (all-branches graph | detail)
 *   - Repo Tree  (mounted by tree.js)
 *
 * Shared helpers come from util.js; the DAG graph from graph.js; the repo tree
 * from tree.js. This module does NOT redefine any of those.
 * -------------------------------------------------------------------------- */

import {
  el,
  setPlaceholder,
  fetchJson,
  showError,
  clearError,
} from './util.js';
import { renderCommitGraph, highlightCommit } from './graph.js';
import { mountRepoTree } from './tree.js';
import { mountBranchTree } from './branches.js';

const HISTORY_LIMIT = 200;
const FULL_LIMIT = 300;

// ---- DOM refs --------------------------------------------------------------
const errorDismissEl = document.getElementById('error-dismiss');

const branchesEl = document.getElementById('branches');
const historyTitleEl = document.getElementById('history-title');
const historyGraphEl = document.getElementById('history-graph');
const historyDetailEl = document.getElementById('history-detail');

const fullGraphEl = document.getElementById('full-graph');
const fullDetailEl = document.getElementById('full-detail');

const repoTreeEl = document.getElementById('repo-tree');
const branchTreeEl = document.getElementById('branch-tree');

const tabEls = Array.from(document.querySelectorAll('.tab[data-tab]'));
const panelEls = Array.from(document.querySelectorAll('.tab-panel[data-tab]'));

// ---- App state -------------------------------------------------------------
const history = {
  selectedBranch: null,
  selectedSha: null,
  commits: [],
  skip: 0,
  loadingMore: false,
};

const full = {
  initialized: false,
  selectedSha: null,
  commits: [],
  skip: 0,
  loadingMore: false,
};

const treeView = { initialized: false };
const branchView = { initialized: false };

let activeTab = 'history';

// ---- Tab switching ---------------------------------------------------------

function activateTab(name) {
  if (activeTab === name && tabInitialized(name)) {
    // already active; nothing to do
  }
  activeTab = name;

  for (const tab of tabEls) {
    const isActive = tab.dataset.tab === name;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  for (const panel of panelEls) {
    const isActive = panel.dataset.tab === name;
    panel.classList.toggle('active', isActive);
    panel.hidden = !isActive;
  }

  // Lazy init on first activation.
  if (name === 'full' && !full.initialized) {
    full.initialized = true;
    loadFullGraph(/* reset */ true);
  } else if (name === 'tree' && !treeView.initialized) {
    treeView.initialized = true;
    mountRepoTree(repoTreeEl, { ref: 'HEAD' });
  } else if (name === 'branches' && !branchView.initialized) {
    branchView.initialized = true;
    loadBranchTree();
  }
}

function tabInitialized(name) {
  if (name === 'full') return full.initialized;
  if (name === 'tree') return treeView.initialized;
  if (name === 'branches') return branchView.initialized;
  return true; // history initializes at startup
}

for (const tab of tabEls) {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
}

// ---- Branches (History left pane) ------------------------------------------

async function loadBranches() {
  setPlaceholder(branchesEl, 'Loading…');
  let branches;
  try {
    branches = await fetchJson('/api/branches');
  } catch (err) {
    showError('Could not load branches: ' + err.message);
    setPlaceholder(branchesEl, 'No branches');
    return;
  }

  if (!Array.isArray(branches) || branches.length === 0) {
    setPlaceholder(branchesEl, 'No branches');
    return;
  }

  const local = branches.filter((b) => b.type === 'local');
  const remote = branches.filter((b) => b.type === 'remote');

  const frag = document.createDocumentFragment();
  if (local.length) frag.appendChild(renderBranchGroup('Local', local));
  if (remote.length) frag.appendChild(renderBranchGroup('Remote', remote));
  branchesEl.replaceChildren(frag);

  // Auto-select the current (HEAD) branch on load, falling back to the first
  // local branch, then any branch.
  const headBranch =
    branches.find((b) => b.isHead) || local[0] || branches[0];
  if (headBranch) {
    let targetRow = null;
    for (const r of branchesEl.querySelectorAll('.branch-row')) {
      if (r.dataset.branch === headBranch.name) {
        targetRow = r;
        break;
      }
    }
    selectBranch(headBranch.name, targetRow);
  }
}

function renderBranchGroup(label, list) {
  const group = el('div', { className: 'branch-group' });
  group.appendChild(el('div', { className: 'group-label', text: label }));
  for (const branch of list) {
    group.appendChild(renderBranchRow(branch));
  }
  return group;
}

function renderBranchRow(branch) {
  const row = el('button', {
    className: 'branch-row',
    attrs: { type: 'button', role: 'listitem', 'data-branch': branch.name },
  });

  row.appendChild(el('span', { className: 'branch-name', text: branch.name }));

  if (branch.isHead) {
    row.appendChild(el('span', { className: 'badge badge-head', text: 'HEAD' }));
  }

  row.addEventListener('click', () => selectBranch(branch.name, row));
  return row;
}

function selectBranch(name, rowEl) {
  if (history.selectedBranch === name) return;
  history.selectedBranch = name;

  for (const r of branchesEl.querySelectorAll('.branch-row.selected')) {
    r.classList.remove('selected');
  }
  if (rowEl) rowEl.classList.add('selected');

  // reset detail
  history.selectedSha = null;
  setPlaceholder(historyDetailEl, 'Select a commit');

  loadHistoryGraph(name, /* reset */ true);
}

// ---- Branches tab (drill-down branch tree chart) ---------------------------

async function loadBranchTree() {
  setPlaceholder(branchTreeEl, 'Loading…');
  let branches;
  try {
    branches = await fetchJson('/api/branches');
  } catch (err) {
    showError('Could not load branches: ' + err.message);
    setPlaceholder(branchTreeEl, 'No branches');
    return;
  }
  mountBranchTree(branchTreeEl, {
    branches: Array.isArray(branches) ? branches : [],
    onSelectBranch: (name) => {
      activateTab('history');
      selectBranchByName(name);
    },
  });
}

/** Select a branch in the History tab by name (used from the Branches tab). */
function selectBranchByName(name) {
  let row = null;
  for (const r of branchesEl.querySelectorAll('.branch-row')) {
    if (r.dataset.branch === name) {
      row = r;
      break;
    }
  }
  // If already selected, ensure the graph is shown but skip a reload.
  if (history.selectedBranch === name) {
    if (row) row.scrollIntoView({ block: 'nearest' });
    return;
  }
  selectBranch(name, row);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// ---- History commit graph (middle pane) ------------------------------------

async function loadHistoryGraph(branch, reset) {
  if (reset) {
    history.commits = [];
    history.skip = 0;
    historyTitleEl.textContent = branch;
    setPlaceholder(historyGraphEl, 'Loading…');
  }

  let page;
  try {
    page = await fetchJson(
      `/api/graph?branch=${encodeURIComponent(branch)}&skip=${history.skip}&limit=${HISTORY_LIMIT}`
    );
  } catch (err) {
    showError('Could not load commits: ' + err.message);
    if (reset) setPlaceholder(historyGraphEl, 'No commits');
    return;
  }

  // Branch changed while in-flight: ignore stale response.
  if (history.selectedBranch !== branch) return;

  if (!Array.isArray(page)) page = [];

  const fullPage = page.length === HISTORY_LIMIT;
  history.commits = history.commits.concat(page);
  history.skip += page.length;

  if (history.commits.length === 0) {
    setPlaceholder(historyGraphEl, 'No commits');
    return;
  }

  drawHistoryGraph(branch, fullPage);
}

function drawHistoryGraph(branch, fullPage) {
  renderCommitGraph(historyGraphEl, history.commits, {
    selectedSha: history.selectedSha,
    onSelect: (sha) => selectHistoryCommit(sha),
    showRefs: true,
  });
  appendLoadMore(historyGraphEl, fullPage, history, () =>
    loadHistoryGraph(branch, /* reset */ false)
  );
}

function selectHistoryCommit(sha) {
  history.selectedSha = sha;
  highlightCommit(historyGraphEl, sha);
  loadDetail(sha, history, historyDetailEl);
}

// ---- Full graph (all branches) ---------------------------------------------

async function loadFullGraph(reset) {
  if (reset) {
    full.commits = [];
    full.skip = 0;
    setPlaceholder(fullGraphEl, 'Loading…');
  }

  let page;
  try {
    page = await fetchJson(
      `/api/graph?all=true&skip=${full.skip}&limit=${FULL_LIMIT}`
    );
  } catch (err) {
    showError('Could not load graph: ' + err.message);
    if (reset) setPlaceholder(fullGraphEl, 'No commits');
    return;
  }

  if (!Array.isArray(page)) page = [];

  const fullPage = page.length === FULL_LIMIT;
  full.commits = full.commits.concat(page);
  full.skip += page.length;

  if (full.commits.length === 0) {
    setPlaceholder(fullGraphEl, 'No commits');
    return;
  }

  drawFullGraph(fullPage);
}

function drawFullGraph(fullPage) {
  renderCommitGraph(fullGraphEl, full.commits, {
    selectedSha: full.selectedSha,
    onSelect: (sha) => selectFullCommit(sha),
    showRefs: true,
  });
  appendLoadMore(fullGraphEl, fullPage, full, () =>
    loadFullGraph(/* reset */ false)
  );
}

function selectFullCommit(sha) {
  full.selectedSha = sha;
  highlightCommit(fullGraphEl, sha);
  loadDetail(sha, full, fullDetailEl);
}

// ---- Shared: "Load more" button --------------------------------------------

/**
 * Append a "Load more" button to a graph container if the last page was full.
 * `flagHolder` carries a `loadingMore` boolean; `loader` returns a promise.
 */
function appendLoadMore(container, fullPage, flagHolder, loader) {
  if (!fullPage) return;
  const moreBtn = el('button', {
    className: 'load-more',
    text: 'Load more',
    attrs: { type: 'button' },
  });
  moreBtn.addEventListener('click', () => {
    if (flagHolder.loadingMore) return;
    flagHolder.loadingMore = true;
    moreBtn.disabled = true;
    moreBtn.textContent = 'Loading…';
    loader().finally(() => {
      flagHolder.loadingMore = false;
    });
  });
  container.appendChild(moreBtn);
}

// ---- Detail (right pane, shared by History & Full Graph) -------------------

async function loadDetail(sha, owner, detailEl) {
  setPlaceholder(detailEl, 'Loading…');

  let detail;
  try {
    detail = await fetchJson('/api/commit/' + encodeURIComponent(sha));
  } catch (err) {
    showError('Could not load commit: ' + err.message);
    setPlaceholder(detailEl, 'Select a commit');
    return;
  }

  // Selection changed while in-flight: ignore stale response.
  if (owner.selectedSha !== sha) return;

  renderDetail(detail, detailEl);
}

function renderDetail(detail, detailEl) {
  const frag = document.createDocumentFragment();

  // Header
  const header = el('div', { className: 'detail-header' });
  header.appendChild(el('h2', { className: 'detail-subject', text: detail.subject }));

  const metaList = el('dl', { className: 'detail-meta' });
  metaList.appendChild(metaRow('commit', detail.sha, true));
  metaList.appendChild(metaRow('author', detail.author, false));
  metaList.appendChild(metaRow('date', detail.dateIso, false));
  header.appendChild(metaList);

  if (detail.body && detail.body.trim() !== '') {
    header.appendChild(el('pre', { className: 'detail-body', text: detail.body }));
  }
  frag.appendChild(header);

  // Files
  const files = Array.isArray(detail.files) ? detail.files : [];
  if (files.length === 0) {
    frag.appendChild(el('div', { className: 'placeholder', text: 'No file changes' }));
  } else {
    for (const file of files) {
      frag.appendChild(renderFile(file));
    }
  }

  detailEl.replaceChildren(frag);
  detailEl.scrollTop = 0;
}

function metaRow(label, value, mono) {
  const wrap = el('div', { className: 'meta-row' });
  wrap.appendChild(el('dt', { text: label }));
  wrap.appendChild(el('dd', { className: mono ? 'mono' : '', text: value }));
  return wrap;
}

const STATUS_LABELS = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed' };

function renderFile(file) {
  const block = el('div', { className: 'file-block' });

  const head = el('div', { className: 'file-head' });
  const status = (file.status || '').toUpperCase().charAt(0);
  const badge = el('span', {
    className: 'badge status-' + (status || 'x'),
    text: status || '?',
    attrs: { title: STATUS_LABELS[status] || 'Unknown' },
  });
  head.appendChild(badge);
  head.appendChild(el('span', { className: 'file-path mono', text: file.path }));
  block.appendChild(head);

  if (file.binary === true) {
    block.appendChild(el('div', { className: 'binary-note', text: 'binary file (no diff)' }));
    return block;
  }

  const diffText = typeof file.diff === 'string' ? file.diff : '';
  if (diffText === '') {
    block.appendChild(el('div', { className: 'binary-note', text: 'no diff' }));
    return block;
  }

  block.appendChild(renderDiff(diffText));
  return block;
}

function renderDiff(diffText) {
  const pre = el('pre', { className: 'diff' });
  const lines = diffText.split('\n');

  for (const line of lines) {
    const lineEl = document.createElement('span');
    lineEl.className = 'diff-line ' + diffLineClass(line);
    lineEl.textContent = line + '\n';
    pre.appendChild(lineEl);
  }
  return pre;
}

function diffLineClass(line) {
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'diff-meta';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return 'diff-ctx';
}

// ---- Resizable panels ------------------------------------------------------

/**
 * Make `.splitter` handles drag-resize their neighbouring pane by setting a CSS
 * variable on the owning grid container.
 *   data-css-var : the CSS custom property to update (column width)
 *   data-side    : "left" resizes the pane before the splitter, "right" after
 *   data-min/max : clamp bounds in px
 */
function initResizers() {
  for (const splitter of document.querySelectorAll('.splitter')) {
    splitter.addEventListener('mousedown', (e) => startResize(e, splitter));
  }
}

function startResize(e, splitter) {
  e.preventDefault();
  const container = splitter.parentElement;
  const cssVar = splitter.dataset.cssVar;
  const side = splitter.dataset.side || 'left';
  const min = parseInt(splitter.dataset.min, 10) || 120;
  const max = parseInt(splitter.dataset.max, 10) || 1200;
  const pane =
    side === 'left' ? splitter.previousElementSibling : splitter.nextElementSibling;
  if (!pane) return;

  splitter.classList.add('dragging');
  document.body.classList.add('resizing');

  const onMove = (ev) => {
    const rect = pane.getBoundingClientRect();
    let width = side === 'left' ? ev.clientX - rect.left : rect.right - ev.clientX;
    width = Math.max(min, Math.min(max, width));
    container.style.setProperty(cssVar, width + 'px');
  };
  const onUp = () => {
    splitter.classList.remove('dragging');
    document.body.classList.remove('resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ---- Init ------------------------------------------------------------------

if (errorDismissEl) errorDismissEl.addEventListener('click', clearError);

initResizers();

// History is the default tab; load its branches immediately.
loadBranches();
