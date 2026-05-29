import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getBranches, getCommits, getCommit } from '../src/git.js';

const execFileAsync = promisify(execFile);

let repo;

function git(args) {
  return execFileAsync('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
}

function write(name, contents) {
  fs.writeFileSync(path.join(repo, name), contents);
}

before(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'meld-git-'));

  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test User']);
  await git(['config', 'commit.gpgsign', 'false']);

  // Commit 1: add a text file (A)
  write('hello.txt', 'line one\nline two\n');
  await git(['add', 'hello.txt']);
  await git(['commit', '-m', 'Add hello.txt']);

  // Commit 2: modify it (M)
  write('hello.txt', 'line one changed\nline two\nline three\n');
  await git(['add', 'hello.txt']);
  await git(['commit', '-m', 'Modify hello.txt']);

  // Commit 3: add a second file
  write('second.txt', 'temporary file\n');
  await git(['add', 'second.txt']);
  await git(['commit', '-m', 'Add second.txt']);

  // Commit 4: delete the second file (D)
  fs.unlinkSync(path.join(repo, 'second.txt'));
  await git(['add', '-A']);
  await git(['commit', '-m', 'Delete second.txt']);

  // Commit 5: add a binary file (bytes including NUL)
  fs.writeFileSync(
    path.join(repo, 'blob.bin'),
    Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x00, 0x42])
  );
  await git(['add', 'blob.bin']);
  await git(['commit', '-m', 'Add binary blob']);

  // Branch: other + a commit
  await git(['checkout', '-b', 'other']);
  write('other.txt', 'on the other branch\n');
  await git(['add', 'other.txt']);
  await git(['commit', '-m', 'Add other.txt on other branch']);

  // Simulate a remote ref so getBranches sees a remote.
  await git(['update-ref', 'refs/remotes/origin/main', 'main']);
  // Symbolic remote HEAD that must be excluded.
  await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

  // Leave HEAD on 'other' for isHead assertions.
});

after(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

test('getBranches finds local and remote branches with correct types', async () => {
  const branches = await getBranches(repo);
  const names = branches.map((b) => b.name);

  assert.ok(names.includes('main'), 'has local main');
  assert.ok(names.includes('other'), 'has local other');
  assert.ok(names.includes('origin/main'), 'has remote origin/main');

  // origin/HEAD symbolic ref must be excluded.
  assert.ok(!names.includes('origin/HEAD'), 'excludes origin/HEAD');

  const main = branches.find((b) => b.name === 'main');
  const other = branches.find((b) => b.name === 'other');
  const remote = branches.find((b) => b.name === 'origin/main');

  assert.equal(main.type, 'local');
  assert.equal(other.type, 'local');
  assert.equal(remote.type, 'remote');

  const headCount = branches.filter((b) => b.isHead).length;
  assert.equal(headCount, 1, 'exactly one isHead');
  assert.equal(other.isHead, true, 'other is the checked-out branch');
});

test('getCommits returns commits newest-first with all fields populated', async () => {
  const commits = await getCommits(repo, 'other');

  assert.ok(commits.length >= 6, 'all commits reachable from other');
  assert.equal(commits[0].subject, 'Add other.txt on other branch');

  for (const c of commits) {
    assert.ok(c.sha && c.sha.length === 40, 'full sha');
    assert.ok(c.shortSha && c.shortSha.length > 0, 'short sha');
    assert.ok(c.author && c.author.length > 0, 'author');
    assert.ok(c.dateRelative && c.dateRelative.length > 0, 'relative date');
    assert.ok(c.dateIso && c.dateIso.length > 0, 'iso date');
    assert.ok(c.subject && c.subject.length > 0, 'subject');
  }
});

test('getCommits respects skip and limit', async () => {
  const all = await getCommits(repo, 'other');

  const one = await getCommits(repo, 'other', { limit: 1 });
  assert.equal(one.length, 1, 'limit:1 -> 1 item');
  assert.equal(one[0].sha, all[0].sha);

  const skipped = await getCommits(repo, 'other', { skip: 1, limit: 1 });
  assert.equal(skipped.length, 1, 'skip:1 limit:1 -> 1 item');
  assert.equal(skipped[0].sha, all[1].sha, 'skip:1 -> next commit');
});

test('getCommit reports correct A status and full metadata', async () => {
  const commits = await getCommits(repo, 'other');
  const addCommit = commits.find((c) => c.subject === 'Add hello.txt');
  const detail = await getCommit(repo, addCommit.sha);

  assert.equal(detail.sha, addCommit.sha);
  assert.ok(detail.author.length > 0);
  assert.ok(detail.dateIso.length > 0);
  assert.equal(detail.subject, 'Add hello.txt');

  const file = detail.files.find((f) => f.path === 'hello.txt');
  assert.ok(file, 'hello.txt present');
  assert.equal(file.status, 'A');
});

test('getCommit reports M status and diff with + and - lines', async () => {
  const commits = await getCommits(repo, 'other');
  const modCommit = commits.find((c) => c.subject === 'Modify hello.txt');
  const detail = await getCommit(repo, modCommit.sha);

  const file = detail.files.find((f) => f.path === 'hello.txt');
  assert.ok(file, 'hello.txt present');
  assert.equal(file.status, 'M');
  assert.equal(file.binary, false);
  assert.match(file.diff, /^\+/m, 'has an added line');
  assert.match(file.diff, /^-/m, 'has a removed line');
  assert.match(file.diff, /^@@/m, 'has a hunk header');
});

test('getCommit reports D status for a deleted file', async () => {
  const commits = await getCommits(repo, 'other');
  const delCommit = commits.find((c) => c.subject === 'Delete second.txt');
  const detail = await getCommit(repo, delCommit.sha);

  const file = detail.files.find((f) => f.path === 'second.txt');
  assert.ok(file, 'second.txt present');
  assert.equal(file.status, 'D');
});

test('getCommit flags binary files with empty diff', async () => {
  const commits = await getCommits(repo, 'other');
  const binCommit = commits.find((c) => c.subject === 'Add binary blob');
  const detail = await getCommit(repo, binCommit.sha);

  const file = detail.files.find((f) => f.path === 'blob.bin');
  assert.ok(file, 'blob.bin present');
  assert.equal(file.binary, true);
  assert.equal(file.diff, '');
  assert.equal(file.status, 'A');
});
