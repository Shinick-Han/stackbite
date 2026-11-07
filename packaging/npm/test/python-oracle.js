'use strict';
// The Python source the npm compatibility tests run as the legacy producer,
// pinned to one commit. The JavaScript under test stays this checkout's
// packaging/npm; only the former Python engine (stackbite.py, private_pty,
// scripts) comes from the last release that shipped it. This mirrors
// rust/test_support/python_oracle_root.rs: same commit, same paths, same
// verification.
//
// root() returns a directory laid out like apps/stackbite holding exactly the
// pinned files. They come from this checkout's Git object store (git ls-tree
// and git cat-file --batch; no network) into
// <tmpdir>/stackbite-python-oracle/<commit prefix>. Every test process re-hashes
// the copy against the commit's blob IDs and rebuilds it when anything differs.
// STACKBITE_PYTHON_ORACLE_ROOT may name an existing copy (such as a frozen
// release source tree) instead; it is used only when its files hash to the
// pinned blobs and it adds no Python module beside them. A missing Git or
// commit fails the test with the reason; nothing is skipped.
//
// Test-only: never shipped (package.json "files" excludes packaging/npm/test).
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The source commit of the frozen 0.5.108 release.
const COMMIT = 'bcd3e47ee369cdbf209688fb8333b7b582e292cb';
const PATHS = ['apps/stackbite/private_pty', 'apps/stackbite/scripts',
  'apps/stackbite/office_backend_bridge.py', 'apps/stackbite/stackbite.py'];
const PREFIX = 'apps/stackbite/';
const ROOT_ENV = 'STACKBITE_PYTHON_ORACLE_ROOT';
const MARKER = '.python-oracle-complete';

function gitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key.toUpperCase())) delete environment[key];
  }
  return environment;
}

function git(args, input) {
  return execFileSync('git', args, { cwd: __dirname, env: gitEnvironment(), input,
    maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Blob ID of every pinned file, keyed by its path below apps/stackbite/. */
function pinnedBlobs() {
  let listing;
  try {
    listing = git(['ls-tree', '-r', '-z', '--full-tree', COMMIT, '--', ...PATHS]);
  } catch (error) {
    throw new Error(`git ls-tree ${COMMIT} in ${__dirname} failed (the commit must be in this checkout's history): `
      + `${String(error.stderr || error.message).trim()}`);
  }
  const blobs = new Map();
  for (const record of listing.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [mode, type, id] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || !file.startsWith(PREFIX)) {
      throw new Error(`unsupported pinned entry ${JSON.stringify(record)}`);
    }
    blobs.set(file.slice(PREFIX.length), id);
  }
  for (const pinned of PATHS) {
    const relative = pinned.slice(PREFIX.length);
    if (![...blobs.keys()].some(key => key === relative || key.startsWith(`${relative}/`))) {
      throw new Error(`${pinned} is missing at the pinned commit`);
    }
  }
  return new Map([...blobs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function blobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Throws unless dir holds every pinned file with the pinned bytes and no other Python module. */
function verify(dir, blobs) {
  for (const [relative, expected] of blobs) {
    const file = path.join(dir, relative);
    let bytes;
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error('not a regular file');
      bytes = fs.readFileSync(file);
    } catch (error) {
      throw new Error(`${file} is missing (${error.code || error.message})`);
    }
    const actual = blobId(bytes);
    if (actual !== expected) throw new Error(`${relative} differs from the pinned source (${actual} != ${expected})`);
  }
  unpinnedPython(dir, '', blobs);
}

// The oracle runs from dir, so a module the pin does not hold could be imported instead.
function unpinnedPython(dir, relative, blobs) {
  for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== '__pycache__' && [...blobs.keys()].some(key => key.startsWith(`${name}/`))) {
        unpinnedPython(dir, name, blobs);
      }
    } else if (/\.(py|pyc|pth)$/.test(entry.name) && !blobs.has(name)) {
      throw new Error(`${name} is not in the pinned source`);
    }
  }
}

/** Writes every pinned blob below dir, which must not exist yet. */
function extract(dir, blobs) {
  const ids = [...blobs.values()];
  const output = git(['cat-file', '--batch'], ids.map(id => `${id}\n`).join(''));
  fs.mkdirSync(dir, { recursive: true });
  let offset = 0;
  for (const [relative, id] of blobs) {
    const end = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, end).toString('utf8').split(' ');
    if (header.length !== 3 || header[0] !== id || header[1] !== 'blob') {
      throw new Error(`git cat-file answered ${JSON.stringify(header.join(' '))} for ${id}`);
    }
    const size = Number(header[2]);
    const bytes = output.subarray(end + 1, end + 1 + size);
    offset = end + 1 + size + 1;
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}

function complete(cache, blobs) {
  try {
    if (fs.readFileSync(path.join(cache, MARKER), 'utf8').trim() !== COMMIT) return false;
    verify(cache, blobs);
    return true;
  } catch { return false; }
}

function sibling(cache, tag) {
  return `${cache}.${tag}-${process.pid}-${process.hrtime.bigint()}`;
}

/**
 * Uses the verified copy at cache, building and publishing one when it is
 * missing or damaged. Test files run as parallel processes and race here on a
 * cold cache: a published copy that verifies is kept (another process may be
 * running from it); only one that fails verification is replaced.
 */
function resolveCache(cache, blobs) {
  if (complete(cache, blobs)) return cache;
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  const fresh = sibling(cache, 'new');
  try {
    extract(fresh, blobs);
    verify(fresh, blobs);
    fs.writeFileSync(path.join(fresh, MARKER), COMMIT);
  } catch (error) {
    fs.rmSync(fresh, { recursive: true, force: true });
    throw error;
  }
  if (fs.existsSync(cache)) {
    if (complete(cache, blobs)) {
      fs.rmSync(fresh, { recursive: true, force: true });
      return cache;
    }
    const stale = sibling(cache, 'stale');
    try {
      fs.renameSync(cache, stale);
      if (complete(stale, blobs)) {
        // Published between the check and the move: put it back and keep it.
        try {
          fs.renameSync(stale, cache);
          fs.rmSync(fresh, { recursive: true, force: true });
          return cache;
        } catch { /* another copy took its place; fall through */ }
      } else fs.rmSync(stale, { recursive: true, force: true });
    } catch { /* another process moved it first */ }
  }
  try {
    fs.renameSync(fresh, cache);
    return cache;
  } catch {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
  // Another process published first; use its copy when it is complete.
  if (fs.existsSync(path.join(cache, MARKER))) {
    verify(cache, blobs);
    return cache;
  }
  throw new Error(`could not publish ${cache}`);
}

function cacheDir() {
  return path.join(os.tmpdir(), 'stackbite-python-oracle', COMMIT.slice(0, 16));
}

function resolve() {
  const blobs = pinnedBlobs();
  const explicit = process.env[ROOT_ENV];
  if (explicit) {
    try { verify(explicit, blobs); } catch (error) { throw new Error(`${ROOT_ENV}=${explicit}: ${error.message}`); }
    return path.resolve(explicit);
  }
  return resolveCache(cacheDir(), blobs);
}

let resolved;
/** The pinned Python source root; throws with the reason when it cannot be provided. */
function root() {
  if (!resolved) {
    try { resolved = { path: resolve() }; } catch (error) { resolved = { error }; }
  }
  if (resolved.error) throw new Error(`Python oracle source at ${COMMIT}: ${resolved.error.message}`);
  return resolved.path;
}

module.exports = { COMMIT, PATHS, ROOT_ENV, root, pinnedBlobs, verify, extract, resolveCache, blobId };
