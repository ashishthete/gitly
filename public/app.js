'use strict';

/* ----------------------------------------------------------------------------
 * Meld — read-only git history viewer (frontend)
 * Vanilla JS, no dependencies, no build step.
 * -------------------------------------------------------------------------- */

const PAGE_LIMIT = 100;

// ---- DOM refs --------------------------------------------------------------
const branchesEl = document.getElementById('branches');
const commitsEl = document.getElementById('commits');
const commitsTitleEl = document.getElementById('commits-title');
const detailEl = document.getElementById('detail');
const errorBannerEl = document.getElementById('error-banner');
const errorMessageEl = document.getElementById('error-message');
const errorDismissEl = document.getElementById('error-dismiss');

// ---- App state -------------------------------------------------------------
const state = {
  selectedBranch: null,
  selectedSha: null,
  commits: [],
  skip: 0,
  loadingMore: false,
};

// ---- Helpers ---------------------------------------------------------------

/** Escape arbitrary text for safe HTML insertion. */
function escapeHtml(value) {
  const str = value == null ? '' : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Create an element with optional class, text, and attributes. */
function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  return node;
}

function showError(message) {
  errorMessageEl.textContent = message || 'Something went wrong.';
  errorBannerEl.hidden = false;
}

function clearError() {
  errorBannerEl.hidden = true;
  errorMessageEl.textContent = '';
}

function setPlaceholder(container, text) {
  container.replaceChildren(el('div', { className: 'placeholder', text }));
}

/** Fetch JSON from the API; throws Error with server-provided message. */
async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (networkErr) {
    throw new Error('Network error: ' + networkErr.message);
  }
  let data = null;
  try {
    data = await res.json();
  } catch (_parseErr) {
    data = null;
  }
  if (!res.ok) {
    const msg = data && data.error ? data.error : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// ---- Branches (left pane) --------------------------------------------------

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

  const name = el('span', { className: 'branch-name', text: branch.name });
  row.appendChild(name);

  if (branch.isHead) {
    row.appendChild(el('span', { className: 'badge badge-head', text: 'HEAD' }));
  }

  row.addEventListener('click', () => selectBranch(branch.name, row));
  return row;
}

function selectBranch(name, rowEl) {
  if (state.selectedBranch === name) return;
  state.selectedBranch = name;

  // highlight
  for (const r of branchesEl.querySelectorAll('.branch-row.selected')) {
    r.classList.remove('selected');
  }
  if (rowEl) rowEl.classList.add('selected');

  // reset detail
  state.selectedSha = null;
  setPlaceholder(detailEl, 'Select a commit');

  loadCommits(name, /* reset */ true);
}

// ---- Commits (middle pane) -------------------------------------------------

async function loadCommits(branch, reset) {
  if (reset) {
    state.commits = [];
    state.skip = 0;
    commitsTitleEl.textContent = branch;
    setPlaceholder(commitsEl, 'Loading…');
  }

  let page;
  try {
    page = await fetchJson(
      `/api/commits?branch=${encodeURIComponent(branch)}&skip=${state.skip}&limit=${PAGE_LIMIT}`
    );
  } catch (err) {
    showError('Could not load commits: ' + err.message);
    if (reset) setPlaceholder(commitsEl, 'No commits');
    return;
  }

  // Branch changed while in-flight: ignore stale response.
  if (state.selectedBranch !== branch) return;

  if (!Array.isArray(page)) page = [];

  const fullPage = page.length === PAGE_LIMIT;
  state.commits = state.commits.concat(page);
  state.skip += page.length;

  if (state.commits.length === 0) {
    setPlaceholder(commitsEl, 'No commits');
    return;
  }

  renderCommits(branch, fullPage);
}

function renderCommits(branch, fullPage) {
  const frag = document.createDocumentFragment();
  for (const commit of state.commits) {
    frag.appendChild(renderCommitRow(commit));
  }

  if (fullPage) {
    const moreBtn = el('button', {
      className: 'load-more',
      text: 'Load more',
      attrs: { type: 'button' },
    });
    moreBtn.addEventListener('click', () => {
      if (state.loadingMore) return;
      state.loadingMore = true;
      moreBtn.disabled = true;
      moreBtn.textContent = 'Loading…';
      loadCommits(branch, /* reset */ false).finally(() => {
        state.loadingMore = false;
      });
    });
    frag.appendChild(moreBtn);
  }

  commitsEl.replaceChildren(frag);

  // re-apply selection highlight after re-render
  if (state.selectedSha) {
    const sel = commitsEl.querySelector(
      `.commit-row[data-sha="${cssEscape(state.selectedSha)}"]`
    );
    if (sel) sel.classList.add('selected');
  }
}

function renderCommitRow(commit) {
  const row = el('button', {
    className: 'commit-row',
    attrs: { type: 'button', role: 'listitem', 'data-sha': commit.sha },
  });

  row.appendChild(el('div', { className: 'commit-subject', text: commit.subject }));

  const meta = el('div', { className: 'commit-meta' });
  meta.appendChild(el('span', { className: 'commit-sha mono', text: commit.shortSha }));
  meta.appendChild(el('span', { className: 'sep', text: '·' }));
  meta.appendChild(el('span', { className: 'commit-author', text: commit.author }));
  meta.appendChild(el('span', { className: 'sep', text: '·' }));
  meta.appendChild(el('span', { className: 'commit-date', text: commit.dateRelative }));
  row.appendChild(meta);

  row.addEventListener('click', () => selectCommit(commit.sha, row));
  return row;
}

/** Minimal CSS attribute-value escaper for querySelector. */
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function selectCommit(sha, rowEl) {
  state.selectedSha = sha;

  for (const r of commitsEl.querySelectorAll('.commit-row.selected')) {
    r.classList.remove('selected');
  }
  if (rowEl) rowEl.classList.add('selected');

  loadDetail(sha);
}

// ---- Detail (right pane) ---------------------------------------------------

async function loadDetail(sha) {
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
  if (state.selectedSha !== sha) return;

  renderDetail(detail);
}

function renderDetail(detail) {
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

// ---- Init ------------------------------------------------------------------

errorDismissEl.addEventListener('click', clearError);

loadBranches();
