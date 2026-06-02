import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

// Field separator (\x1f) and record separator (\x1e) so parsing survives
// arbitrary content like multi-line subjects.
const FS = '\x1f';
const RS = '\x1e';

/**
 * Private helper. Runs a git command (read-only) with cwd = repoRoot.
 * Rejects on non-zero exit, surfacing stderr.
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {Promise<string>} stdout
 */
async function run(repoRoot, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    const message = stderr || (err && err.message) || 'git command failed';
    const wrapped = new Error(`git ${args.join(' ')}: ${message}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

/**
 * Like run(), but returns stdout as a Buffer (for binary-safe content).
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {Promise<Buffer>} stdout
 */
async function runBuffer(repoRoot, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot,
      maxBuffer: MAX_BUFFER,
      encoding: 'buffer',
    });
    return stdout;
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    const message = stderr || (err && err.message) || 'git command failed';
    const wrapped = new Error(`git ${args.join(' ')}: ${message}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

/**
 * List local and remote branches.
 * @param {string} repoRoot
 * @returns {Promise<Array<{name: string, type: 'local'|'remote', isHead: boolean}>>}
 */
export async function getBranches(repoRoot) {
  // %(HEAD) is '*' for the checked-out branch, ' ' otherwise.
  const format = ['%(refname)', '%(HEAD)'].join(FS);
  const stdout = await run(repoRoot, [
    'for-each-ref',
    `--format=${format}`,
    'refs/heads',
    'refs/remotes',
  ]);

  const branches = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [refname, head] = line.split(FS);
    if (!refname) continue;

    let type;
    let name;
    if (refname.startsWith('refs/heads/')) {
      type = 'local';
      name = refname.slice('refs/heads/'.length);
    } else if (refname.startsWith('refs/remotes/')) {
      type = 'remote';
      name = refname.slice('refs/remotes/'.length);
      // Exclude symbolic remote HEAD refs like origin/HEAD.
      if (name.endsWith('/HEAD')) continue;
    } else {
      continue;
    }

    branches.push({
      name,
      type,
      isHead: head === '*',
    });
  }

  return branches;
}

/**
 * List commits reachable from a branch, newest first.
 * @param {string} repoRoot
 * @param {string} branch
 * @param {{skip?: number, limit?: number}} [opts]
 * @returns {Promise<Array<{sha,shortSha,author,dateRelative,dateIso,subject}>>}
 */
export async function getCommits(repoRoot, branch, { skip = 0, limit = 100 } = {}) {
  const fields = ['%H', '%h', '%an', '%ar', '%aI', '%s'].join('%x1f');
  const format = `${fields}%x1e`;

  const stdout = await run(repoRoot, [
    'log',
    branch,
    `--skip=${skip}`,
    `--max-count=${limit}`,
    `--format=${format}`,
  ]);

  const commits = [];
  for (const record of stdout.split(RS)) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed) continue;
    const parts = trimmed.split(FS);
    if (parts.length < 6) continue;
    const [sha, shortSha, author, dateRelative, dateIso, subject] = parts;
    commits.push({ sha, shortSha, author, dateRelative, dateIso, subject });
  }

  return commits;
}

/**
 * Detailed view of a single commit, including per-file diffs.
 * @param {string} repoRoot
 * @param {string} sha
 * @returns {Promise<{sha,author,dateIso,subject,body,files:Array<{path,status,binary,diff}>}>}
 */
export async function getCommit(repoRoot, sha) {
  // Metadata + full patch. %x1f separates fields, %x1e marks end of metadata
  // so the patch that follows can be split off cleanly. --first-parent keeps
  // merge commits to a single, sensible diff.
  const metaFields = ['%H', '%an', '%aI', '%s', '%b'].join('%x1f');
  const metaFormat = `${metaFields}%x1e`;

  const showOut = await run(repoRoot, [
    'show',
    sha,
    '--first-parent',
    `--format=${metaFormat}`,
    '--patch',
  ]);

  const sepIdx = showOut.indexOf(RS);
  const metaBlock = sepIdx === -1 ? showOut : showOut.slice(0, sepIdx);
  let patchBlock = sepIdx === -1 ? '' : showOut.slice(sepIdx + 1);
  // Drop the leading newline(s) git inserts between the format line and patch.
  patchBlock = patchBlock.replace(/^\n+/, '');

  const metaParts = metaBlock.split(FS);
  const [resolvedSha, author, dateIso, subject, body = ''] = metaParts;

  // Authoritative statuses (and rename source->dest) via --name-status.
  // Empty --format suppresses commit header lines.
  const statusOut = await run(repoRoot, [
    'show',
    sha,
    '--first-parent',
    '--name-status',
    '--format=',
  ]);

  // path -> { status, newPath }
  const statusMap = new Map();
  for (const line of statusOut.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const rawStatus = cols[0];
    const code = rawStatus[0]; // R100 -> R, C75 -> C, etc.
    if (code === 'R' || code === 'C') {
      // cols: [status, oldPath, newPath]
      const newPath = cols[2];
      statusMap.set(newPath, { status: code === 'C' ? 'A' : 'R', display: newPath });
    } else {
      const p = cols[1];
      statusMap.set(p, { status: normalizeStatus(code), display: p });
    }
  }

  const files = parsePatch(patchBlock, statusMap);

  return {
    sha: resolvedSha || sha,
    author: author || '',
    dateIso: dateIso || '',
    subject: subject || '',
    body: (body || '').replace(/\n+$/, ''),
    files,
  };
}

/**
 * Commit graph: commits with parent SHAs and ref decorations, topo-ordered.
 * @param {string} repoRoot
 * @param {{branch?: string, all?: boolean, skip?: number, limit?: number}} [opts]
 * @returns {Promise<Array<{sha,shortSha,parents,author,dateRelative,dateIso,subject,refs}>>}
 */
export async function getGraph(
  repoRoot,
  { branch, all = false, skip = 0, limit = 200 } = {}
) {
  const fields = ['%H', '%h', '%P', '%an', '%ar', '%aI', '%s', '%D'].join('%x1f');
  const format = `${fields}%x1e`;

  // Shared revision selection so the stats passes cover the exact same commits.
  const revArgs = ['--topo-order', `--skip=${skip}`, `--max-count=${limit}`];
  if (all) {
    revArgs.push('--all');
  } else {
    revArgs.push(branch && branch.length ? branch : 'HEAD');
  }

  const stdout = await run(repoRoot, ['log', ...revArgs, `--format=${format}`]);
  const stats = await collectGraphStats(repoRoot, revArgs);

  const commits = [];
  for (const record of stdout.split(RS)) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed) continue;
    const parts = trimmed.split(FS);
    if (parts.length < 8) continue;
    const [sha, shortSha, parentsRaw, author, dateRelative, dateIso, subject, decorate] =
      parts;
    const parents = parentsRaw.split(' ').filter((p) => p.length > 0);
    const refs = decorate
      .split(', ')
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    const s = stats.get(sha) || emptyStats();
    commits.push({
      sha,
      shortSha,
      parents,
      author,
      dateRelative,
      dateIso,
      subject,
      refs,
      stats: s,
    });
  }

  return commits;
}

function emptyStats() {
  return {
    linesAdded: 0,
    linesRemoved: 0,
    filesAdded: 0,
    filesModified: 0,
    filesRemoved: 0,
  };
}

/**
 * Per-commit change stats (line +/- and file add/modify/remove counts) for a
 * set of revisions. Two cheap `git log` passes keyed by SHA: `--numstat` for
 * line counts, `--name-status` for the file-status breakdown. Merge commits
 * carry no diff under plain `git log`, so they report zeros (matching the
 * single-commit detail view, which is --first-parent based).
 * @returns {Promise<Map<string, ReturnType<typeof emptyStats>>>}
 */
async function collectGraphStats(repoRoot, revArgs) {
  const stats = new Map();
  const ensure = (sha) => {
    let s = stats.get(sha);
    if (!s) {
      s = emptyStats();
      stats.set(sha, s);
    }
    return s;
  };

  // Line counts. Each commit block begins with a "\x1e<sha>" marker line.
  const numOut = await run(repoRoot, ['log', ...revArgs, `--format=${RS}%H`, '--numstat']);
  let cur = null;
  for (const line of numOut.split('\n')) {
    if (line.startsWith(RS)) {
      cur = ensure(line.slice(1));
      continue;
    }
    if (!cur || !line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    // Binary files report '-' for both counts.
    const add = cols[0] === '-' ? 0 : parseInt(cols[0], 10) || 0;
    const del = cols[1] === '-' ? 0 : parseInt(cols[1], 10) || 0;
    cur.linesAdded += add;
    cur.linesRemoved += del;
  }

  // File-status breakdown.
  const nameOut = await run(repoRoot, ['log', ...revArgs, `--format=${RS}%H`, '--name-status']);
  cur = null;
  for (const line of nameOut.split('\n')) {
    if (line.startsWith(RS)) {
      cur = ensure(line.slice(1));
      continue;
    }
    if (!cur || !line.trim()) continue;
    const code = line[0];
    if (code === 'A' || code === 'C') cur.filesAdded++;
    else if (code === 'D') cur.filesRemoved++;
    else cur.filesModified++; // M, R (rename), T (type change), etc.
  }

  return stats;
}

/**
 * List every tree entry recursively at a ref (files and directories).
 * @param {string} repoRoot
 * @param {string} [ref]
 * @returns {Promise<Array<{path, type, size}>>}
 */
export async function getTree(repoRoot, ref = 'HEAD') {
  // <mode> <type> <object> <size>\t<path>
  const stdout = await run(repoRoot, ['ls-tree', '-r', '-t', '-l', ref]);

  const entries = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;
    const meta = line.slice(0, tabIdx);
    const path = line.slice(tabIdx + 1);
    const cols = meta.split(/\s+/);
    // cols: [mode, type, object, size]
    const type = cols[1];
    const sizeRaw = cols[3];
    const size = sizeRaw === '-' ? null : parseInt(sizeRaw, 10);
    entries.push({ path, type, size });
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/**
 * Read a file's content at a ref, with binary detection and truncation.
 * @param {string} repoRoot
 * @param {string} [ref]
 * @param {string} filePath
 * @returns {Promise<{path, content, binary, size, truncated}>}
 */
export async function getFileContent(repoRoot, ref = 'HEAD', filePath) {
  const buf = await runBuffer(repoRoot, ['show', `${ref}:${filePath}`]);

  const size = buf.length;

  // Binary if a NUL byte appears in the first ~8000 bytes.
  const sniffLen = Math.min(size, 8000);
  let binary = false;
  for (let i = 0; i < sniffLen; i++) {
    if (buf[i] === 0x00) {
      binary = true;
      break;
    }
  }

  if (binary) {
    return { path: filePath, content: '', binary: true, size, truncated: false };
  }

  const MAX_TEXT = 2 * 1024 * 1024;
  let truncated = false;
  let slice = buf;
  if (size > MAX_TEXT) {
    slice = buf.subarray(0, MAX_TEXT);
    truncated = true;
  }
  const content = slice.toString('utf8');

  return { path: filePath, content, binary: false, size, truncated };
}

function normalizeStatus(code) {
  if (code === 'A' || code === 'M' || code === 'D' || code === 'R') return code;
  // Treat copies, type changes, etc. conservatively.
  if (code === 'C') return 'A';
  if (code === 'T') return 'M';
  return 'M';
}

/**
 * Split a unified patch into per-file sections on `diff --git` boundaries.
 * @param {string} patch
 * @param {Map<string, {status:string, display:string}>} statusMap
 * @returns {Array<{path, status, binary, diff}>}
 */
function parsePatch(patch, statusMap) {
  const files = [];
  if (!patch) {
    // No textual patch (e.g. pure rename / mode change). Fall back to statuses.
    for (const [path, info] of statusMap) {
      files.push({ path, status: info.status, binary: false, diff: '' });
    }
    return files;
  }

  // Split keeping the "diff --git" header with its section.
  const sections = patch.split(/(?=^diff --git )/m).filter((s) => s.trim());

  for (const section of sections) {
    const path = extractPath(section);
    const isBinary =
      /^Binary files /m.test(section) || /^GIT binary patch/m.test(section);

    const info = path ? statusMap.get(path) : undefined;
    const status = info ? info.status : statusFromSection(section);

    files.push({
      path: path || '',
      status,
      binary: isBinary,
      diff: isBinary ? '' : section.replace(/\n+$/, '\n'),
    });
  }

  // Include any status-only files that produced no patch section (rare).
  for (const [path, info] of statusMap) {
    if (!files.some((f) => f.path === path)) {
      files.push({ path, status: info.status, binary: false, diff: '' });
    }
  }

  return files;
}

function statusFromSection(section) {
  if (/^new file mode /m.test(section)) return 'A';
  if (/^deleted file mode /m.test(section)) return 'D';
  if (/^rename to /m.test(section)) return 'R';
  return 'M';
}

/**
 * Extract the target file path from a single `diff --git` section.
 * Prefers the +++ b/ line, then rename info, then the `diff --git a/x b/y` line.
 */
function extractPath(section) {
  const renameTo = section.match(/^rename to (.+)$/m);
  if (renameTo) return renameTo[1];

  const plus = section.match(/^\+\+\+ b\/(.+)$/m);
  if (plus && plus[1] !== '/dev/null') return plus[1];

  // Deleted files: --- a/path, +++ /dev/null
  const minus = section.match(/^--- a\/(.+)$/m);
  if (minus && minus[1] !== '/dev/null') {
    // Only use this as path if +++ was /dev/null (deletion).
    const plusDevNull = /^\+\+\+ \/dev\/null$/m.test(section);
    if (plusDevNull) return minus[1];
  }

  // Fall back to the diff --git header. Handles paths without spaces.
  const header = section.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (header) return header[2];

  return '';
}
