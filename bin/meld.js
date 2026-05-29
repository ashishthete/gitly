#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';

import { startServer } from '../src/server.js';

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function main() {
  const cwd = process.cwd();

  // Verify we're inside a git work tree.
  try {
    await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      process.stderr.write('git was not found on your PATH. Please install git.\n');
      process.exit(1);
    }
    process.stderr.write(`Not a git repository: ${cwd}\n`);
    process.exit(1);
  }

  // Resolve repo root.
  let repoRoot;
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
    repoRoot = stdout.trim();
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      process.stderr.write('git was not found on your PATH. Please install git.\n');
      process.exit(1);
    }
    process.stderr.write(`Not a git repository: ${cwd}\n`);
    process.exit(1);
  }

  const freePort = await getFreePort();
  const { server, port } = await startServer({ repoRoot, port: freePort });

  const urlStr = `http://localhost:${port}`;
  process.stdout.write(`Meld viewing ${repoRoot}\n`);
  process.stdout.write(`Open: ${urlStr}\n`);
  process.stdout.write('Press Ctrl-C to stop.\n');

  // Open the browser (macOS). Don't crash if it fails.
  try {
    const child = spawn('open', [urlStr], { stdio: 'ignore' });
    child.on('error', () => {});
  } catch {
    // Ignore — browser launch is best-effort.
  }

  process.on('SIGINT', () => {
    server.close(() => {
      process.exit(0);
    });
  });
}

main().catch((err) => {
  process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
