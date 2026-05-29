import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBranches, getCommits, getCommit } from './git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(res, entry) {
  // Resolve the file inside PUBLIC_DIR and guard against traversal.
  const filePath = path.resolve(PUBLIC_DIR, entry.file);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': entry.type });
    res.end(data);
  });
}

export async function startServer({ repoRoot, port }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;

      // Static assets
      const staticEntry = STATIC_FILES[pathname];
      if (staticEntry) {
        serveStatic(res, staticEntry);
        return;
      }

      // API: branches
      if (pathname === '/api/branches') {
        const branches = await getBranches(repoRoot);
        sendJson(res, 200, branches);
        return;
      }

      // API: commits
      if (pathname === '/api/commits') {
        const branch = url.searchParams.get('branch');
        if (!branch) {
          sendJson(res, 400, { error: 'branch is required' });
          return;
        }
        const skipRaw = parseInt(url.searchParams.get('skip'), 10);
        const limitRaw = parseInt(url.searchParams.get('limit'), 10);
        const skip = Number.isNaN(skipRaw) ? 0 : skipRaw;
        const limit = Number.isNaN(limitRaw) ? 100 : limitRaw;
        const commits = await getCommits(repoRoot, branch, { skip, limit });
        sendJson(res, 200, commits);
        return;
      }

      // API: single commit
      if (pathname.startsWith('/api/commit/')) {
        const shaPart = pathname.slice('/api/commit/'.length);
        const sha = decodeURIComponent(shaPart);
        if (!sha) {
          sendJson(res, 400, { error: 'sha is required' });
          return;
        }
        const commit = await getCommit(repoRoot, sha);
        sendJson(res, 200, commit);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { error: err && err.message ? err.message : String(err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const boundPort = server.address().port;
  return { server, port: boundPort };
}
