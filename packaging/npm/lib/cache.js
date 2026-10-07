'use strict';
const path = require('node:path');
const os = require('node:os');

function cacheDirectory(environment = process.env, platform = process.platform, home = os.homedir()) {
  return platform === 'win32'
    ? path.resolve(environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Stackbite', 'cache')
    : path.resolve(environment.XDG_CACHE_HOME || path.join(environment.HOME || home, '.cache'), 'stackbite');
}
module.exports = { cacheDirectory };
