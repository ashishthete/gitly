# gitly

A lightweight, **read-only** git viewer for macOS. Run one command inside any
git repository and a browser UI opens where you can browse branches, commits,
the commit graph, diffs, and the full file tree. It **never modifies** your
repo — no staging, committing, checkout, or merging. Just looking.

> Named `gitly` to avoid any clash with GNOME Meld.

## What you can do

- **History tab** — pick a branch, see its commits drawn as a **branch graph**
  (colored lanes/dots), and click any commit to see the full red/green
  line-by-line diff of every changed file.
- **Full Graph tab** — the commit graph across **all branches at once**, with
  branch/tag/remote ref labels. Click a commit for its diffs.
- **Repo Tree tab** — browse the **entire repository's** folder/file tree and
  click any file to view its contents (with line numbers).

The current (checked-out) branch is selected automatically when you open it.

## Requirements

- macOS
- [Node.js](https://nodejs.org/) 18 or newer (`node -v`)
- `git` on your `PATH` (`git --version`)

No other dependencies — gitly uses only Node's built-ins and your existing
`git`. Nothing is installed into your repo, and the server binds to
`127.0.0.1` only (never exposed off your machine).

## Install

Clone or copy this folder somewhere permanent, then link the command once:

```sh
cd /path/to/gitly      # this project folder
npm link               # adds the global `gitly` command
```

`npm link` creates a global symlink — there are no packages to download.
To remove it later: `npm unlink -g gitly`.

## Use

From inside **any** git repository:

```sh
cd /path/to/your/repo
gitly
```

gitly finds the repo at your current folder, starts a tiny local server, and
opens it in your default browser. **Press `Ctrl-C`** in the terminal to stop.

If it prints `Not a git repository: …`, you're not inside a git repo — `cd`
into one first.

## Develop

```sh
npm test               # runs the git-layer unit tests against a throwaway temp repo
```

### Project layout

```
bin/meld.js        # CLI entry: resolves the repo, starts the server, opens the browser
src/git.js         # read-only git wrapper (branches, commits, graph, tree, file, diffs)
src/server.js      # zero-dependency HTTP server: static files + JSON API
public/            # frontend (vanilla JS modules, no build step):
  index.html       #   tab shell
  app.js           #   tabs + branches + detail wiring
  graph.js         #   commit-graph (branch DAG) renderer
  tree.js          #   repo file-tree browser + file viewer
  util.js          #   shared helpers
  *.css            #   styles
test/git.test.js   # unit tests for the git layer
docs/              # design spec
```

### HTTP API (all read-only, JSON)

| Route | Purpose |
|---|---|
| `GET /api/branches` | local + remote branches |
| `GET /api/graph?branch=X&skip=&limit=` | commits for a branch (with parents/refs) |
| `GET /api/graph?all=true&skip=&limit=` | commits across all branches |
| `GET /api/commit/<sha>` | commit metadata + per-file diffs |
| `GET /api/tree?ref=HEAD` | full repo file tree |
| `GET /api/file?ref=HEAD&path=…` | a file's contents |

See `docs/superpowers/specs/` for the full design.
