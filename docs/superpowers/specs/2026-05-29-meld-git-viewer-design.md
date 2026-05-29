# Meld — Read-Only Git History Viewer (macOS)

**Date:** 2026-05-29
**Status:** Approved design

## Purpose

A lightweight, **view-only** desktop tool for browsing a local git repository's
history on macOS. You run a terminal command inside a repo and a browser-based UI
opens showing all branches, the commits on each branch, and the full line-by-line
diff for every file changed in a commit.

It does **not** stage, commit, merge, checkout, edit, or modify anything. It only
reads.

## Constraints

- **Lightweight above all.** Zero npm dependencies — Node.js built-in modules only
  (`http`, `child_process`, `fs`, `path`, `url`, `os`, `net`).
- No bundled browser or runtime: reuses the system's default browser and the
  already-installed `git` binary.
- No persistent process, no indexing, no caching layer. The server runs only while
  the user is viewing and runs git commands on demand.
- Frontend is plain HTML/CSS/JS — no framework, no build step, no bundler.
- Total footprint: a handful of small source files; starts instantly.

## Success Criteria

1. Running `meld` inside a git repo opens the UI in the default browser.
2. Running `meld` outside a git repo prints a clear message and exits non-zero.
3. The UI lists all branches (local and remote).
4. Selecting a branch lists its commits (sha, author, relative date, subject).
5. Selecting a commit shows every changed file with its full unified diff,
   added lines green / removed lines red.
6. Binary files are listed but show "binary file (no diff)".
7. No write operation against the repository is ever performed.

## Architecture

A single small Node.js package, installed so a `meld` command is on the user's PATH.

```
meld (CLI)
  └─ resolves cwd, verifies .git, picks free port
  └─ starts HTTP server (Node built-in http)
        ├─ serves static frontend (public/)
        └─ JSON API  ──shells out to──▶  git binary
  └─ runs `open http://localhost:PORT`  ──▶  default browser renders UI
```

**Flow:** `meld` in a repo → verify git repo → find free port → start server →
`open` the URL. The server lives in the foreground; Ctrl-C in the terminal stops it.

## Components

### `bin/meld.js` — CLI entry
- Resolve `process.cwd()` as the repo root candidate.
- Verify it is inside a git work tree
  (`git rev-parse --is-inside-work-tree`); if not, print message and `exit(1)`.
- Resolve the actual repo top level (`git rev-parse --show-toplevel`).
- Pick a free port (bind to port 0 via the `net` module to discover one).
- Start the server, then spawn `open http://localhost:PORT`.
- Print the URL and a "Press Ctrl-C to stop" line.

### `src/server.js` — HTTP server
- Node built-in `http`. Routes:
  - Static: `/` → `index.html`, plus `/app.js`, `/style.css` from `public/`.
  - API routes (below).
- Repo root is passed in from the CLI; all git calls run with `cwd` = repo root.
- Any thrown error in an API handler → `500` with `{ error: message }` JSON.
- Binds to `127.0.0.1` only (never exposed off-machine).

### `src/git.js` — git wrapper
Thin functions that exec the `git` binary and parse stdout. All read-only.
- `getBranches()` → `git for-each-ref --format=...` over `refs/heads` and
  `refs/remotes`; returns `[{ name, type: 'local'|'remote', isHead }]`.
- `getCommits(branch, { skip, limit })` → `git log <branch> --skip --max-count
  --format=<delimited>`; returns `[{ sha, shortSha, author, dateRelative,
  dateIso, subject }]`. Supports paging for lazy loading.
- `getCommit(sha)` → metadata + changed files with per-file unified diffs.
  Uses `git show <sha> --format=<meta> --patch` (or a `--name-status` pass plus
  per-file `git show`), classifying each file as added/modified/deleted/binary.
- A single private `run(args)` helper wraps `execFile('git', args, { cwd })`
  with a generous `maxBuffer`, rejecting on non-zero exit.

Git invocation uses `execFile` with argument arrays (never a shell string), so
branch names / shas cannot inject shell commands.

### `public/` — frontend
- `index.html`: three-pane layout — **branches sidebar │ commit list │ diff view**.
- `app.js`: vanilla JS. Fetches the API, renders panes, handles clicks.
  - Click branch → load commits (paged; "load more" / infinite scroll).
  - Click commit → load commit detail → render each file with its diff.
  - Diff rendering: split unified-diff text into lines; class each line as
    add / remove / context / hunk-header and color accordingly.
- `style.css`: simple dark-ish three-pane layout, monospace diffs.

## API

| Method | Route | Returns |
|---|---|---|
| GET | `/api/branches` | `[{ name, type, isHead }]` |
| GET | `/api/commits?branch=X&skip=N&limit=M` | `[{ sha, shortSha, author, dateRelative, dateIso, subject }]` |
| GET | `/api/commit/:sha` | `{ sha, author, dateIso, subject, body, files: [{ path, status, binary, diff }] }` |

Defaults: `limit=100` for commits. Diffs for all files in a commit are returned
in the `/api/commit/:sha` response; the commit list itself is what's paged.

## Data Flow

Browser `fetch` → server route → `git.js` runs `git` with `cwd`=repo root →
stdout parsed to JSON → response → `app.js` renders. Nothing is stored between
requests.

## Error Handling

- **Not a git repo:** CLI prints `"Not a git repository: <path>"` and exits 1.
- **git binary missing:** CLI prints a clear message and exits 1.
- **API/git command failure:** handler returns `500 { error }`; UI shows a
  non-blocking banner, no crash.
- **Empty repo / branch with no commits:** UI shows an empty-state message.
- **Binary file:** listed with `binary: true`, diff omitted, UI shows
  "binary file (no diff)".
- **Port in use:** free-port discovery avoids collisions; if `open` fails, the
  URL is still printed for manual paste.

## Testing

- **`git.js` is the unit under test.** Test setup builds a throwaway temp repo
  (`git init` in an `os.tmpdir()` folder, configured user, a few commits across
  two branches, an added/modified/deleted file, and a binary file).
- Assertions: `getBranches` finds both branches and flags HEAD; `getCommits`
  returns commits in order with parsed fields and respects `skip`/`limit`;
  `getCommit` returns correct file statuses and that the diff text contains the
  expected `+`/`-` lines; binary file flagged `binary: true`.
- Temp repo is removed in teardown.
- Test runner: Node's built-in `node:test` + `node:assert` (no dependency).

## Project Layout

```
meld/
  bin/meld.js
  src/server.js
  src/git.js
  public/index.html
  public/app.js
  public/style.css
  test/git.test.js
  package.json        # name, bin: { meld: bin/meld.js }, type: module, test script
  README.md
```

## Out of Scope (YAGNI)

- Any write/mutating git operation (commit, stage, checkout, merge, rebase, push).
- Authentication, multi-user, remote hosting (binds to localhost only).
- Side-by-side diff view (unified diff only, per approved scope).
- Commit graph visualization (branch sidebar + flat commit list only).
- Search, blame, file tree browsing, settings/preferences.
- Packaging as a signed `.app` bundle.
