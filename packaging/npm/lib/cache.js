'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { fail } = require('./common');

function cacheDirectory(environment = process.env, platform = process.platform, home = os.homedir()) {
  return platform === 'win32'
    ? path.resolve(environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Stackbite', 'cache')
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
module.exports = { cacheDirectory, existingCacheDirectory };
