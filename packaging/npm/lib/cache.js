'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { fail } = require('./common');

function cacheDirectory(environment = process.env, platform = process.platform, home = os.homedir()) {
  return platform === 'win32'
    ? path.resolve(environment.LOCALAPPDATA || path.join(environment.USERPROFILE || home, 'AppData', 'Local'), 'Stackbite', 'cache')
    : path.resolve(environment.XDG_CACHE_HOME || path.join(environment.HOME || home, '.cache'), 'stackbite');
}
// Check every ancestor without creating anything, including for an absent cache.
async function existingCacheDirectory(directory) {
  directory = path.resolve(directory);
  const parent = path.dirname(directory);
  if (parent !== directory && !await existingCacheDirectory(parent)) return false;
  let info;
  try { info = await fs.lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Cache directory contains a link or non-directory');
  return true;
}
// Resolve the selected cache path once, including an absent suffix. Internal
// payload paths still use the link checks and pinned hashes in bootstrap.
async function resolveCacheDirectory(directory) {
  directory = path.resolve(directory);
  const missing = [];
  let current = directory;
  for (;;) {
    try {
      const resolved = await fs.realpath(current);
      if (!(await fs.stat(resolved)).isDirectory()) fail('Cache directory contains a non-directory');
      return path.join(resolved, ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
module.exports = { cacheDirectory, existingCacheDirectory, resolveCacheDirectory };
