'use strict';

/* ----------------------------------------------------------------------------
 * Meld — shared frontend helpers (ES module). No dependencies.
 * Imported by app.js, graph.js, and tree.js.
 * -------------------------------------------------------------------------- */

/** Escape arbitrary text for safe HTML insertion. */
export function escapeHtml(value) {
  const str = value == null ? '' : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Create an element with optional class, text, and attributes. */
export function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  return node;
}

/** Replace a container's contents with a single placeholder message. */
export function setPlaceholder(container, text) {
  container.replaceChildren(el('div', { className: 'placeholder', text }));
}

/** Minimal CSS attribute-value escaper for querySelector. */
export function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

/** Fetch JSON from the API; throws Error with the server-provided message. */
export async function fetchJson(url) {
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

/* Error banner — expects #error-banner / #error-message / #error-dismiss in the
 * page (provided by index.html). Safe no-ops if absent. */
export function showError(message) {
  const banner = document.getElementById('error-banner');
  const msg = document.getElementById('error-message');
  if (msg) msg.textContent = message || 'Something went wrong.';
  if (banner) banner.hidden = false;
}

export function clearError() {
  const banner = document.getElementById('error-banner');
  const msg = document.getElementById('error-message');
  if (banner) banner.hidden = true;
  if (msg) msg.textContent = '';
}
