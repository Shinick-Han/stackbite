'use strict';
const fs = require('node:fs/promises');
const { createReadStream, statSync, openSync, fstatSync, readSync, closeSync } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const LIMITS = Object.freeze({ download: 512 * 1024 * 1024, expanded: 1024 * 1024 * 1024,
  member: 128 * 1024 * 1024, metadata: 2 * 1024 * 1024, members: 25000, timeout: 120000 });
function fail(message) { throw new Error(message); }
function memberPath(name) {
  if (typeof name !== 'string' || !name || name.length > 1024 || /[\\:<>"|?*\x00-\x1f\x7f]/.test(name)) fail('Unsafe archive path');
  const cleaned = name.endsWith('/') ? name.slice(0, -1) : name;
  const parts = cleaned.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part)
      || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) fail('Unsafe archive path');
  return cleaned;
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function hashFile(filename, maximum = LIMITS.member) {
  const info = await fs.stat(filename);
  if (!info.isFile() || info.size > maximum) fail('Release file exceeds its size limit');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    if (size > maximum) fail('Release file exceeds its size limit');
    hash.update(chunk);
  }
  return hash.digest('hex');
}
// hashFile for a caller with nothing else on the event loop: the same refusals and digest, read
// synchronously into one reused buffer. The descriptor that is measured is the one that is hashed.
const HASH_BUFFER = 1024 * 1024;
let hashBuffer = null;
function hashFileSync(filename, maximum = LIMITS.member) {
  if (!statSync(filename).isFile()) fail('Release file exceeds its size limit');
  const descriptor = openSync(filename, 'r');
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maximum) fail('Release file exceeds its size limit');
    const hash = createHash('sha256'), buffer = hashBuffer ??= Buffer.allocUnsafe(HASH_BUFFER);
    let size = 0;
    for (let count; (count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) {
      size += count;
      if (size > maximum) fail('Release file exceeds its size limit');
      hash.update(count === buffer.length ? buffer : buffer.subarray(0, count));
    }
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}
async function readSmall(filename, maximum = LIMITS.metadata) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) fail('Unsafe or oversized release metadata');
  return fs.readFile(filename);
}
async function exists(filename) {
  try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function safeDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) await safeDirectory(parent);
  if (!await exists(directory)) {
    try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Cache directory contains a link or non-directory');
}
module.exports = { LIMITS, fail, memberPath, inside, hashFile, hashFileSync, readSmall, exists, safeDirectory };
