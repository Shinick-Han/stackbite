'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { readSmall, fail } = require('./common');

function shellLiteral(value) {
  if (!value.startsWith("'") || !value.endsWith("'")) return null;
  const parts = value.slice(1, -1).split("'\\''");
  if (parts.some(part => /['\r\n\0]/.test(part))) return null;
  return parts.join("'");
}
function managedState(content) {
  const lines = content.split('\n');
  if (lines.length !== 8 || lines[0] !== '#!/bin/sh' || !/^# (Helm|Stackbite) managed launcher$/.test(lines[1])
      || lines[2] !== 'if [ -z "${HELM_STATE_DIR:-}" ]; then' || lines[4] !== '  export HELM_STATE_DIR'
      || lines[5] !== 'fi' || lines[7] !== '' || !lines[3].startsWith('  HELM_STATE_DIR=')
      || !lines[6].startsWith('exec ') || !lines[6].endsWith(' "$@"')) return null;
  const state = shellLiteral(lines[3].slice('  HELM_STATE_DIR='.length));
  const image = shellLiteral(lines[6].slice(5, -5));
  if (!state || !path.isAbsolute(state) || !image || !path.isAbsolute(image)
      || !['stackbite', 'helm'].includes(path.basename(image))) return null;
  return state;
}
function windowsManagedState(content, appRoot) {
  // Exact portable-installer grammar, including the original unmarked Helm
  // launcher. Values are read literally; no CMD expansion or execution occurs.
  const match = /^@echo off\r?\n(?:rem Stackbite managed launcher\r?\n)?setlocal\r?\nset "HELM_HOME=(?<home>[^"%\r\n\0]+)"\r?\nset "HELM_STATE_DIR=(?<state>[^"%\r\n\0]+)"\r?\n"\k<home>\\(?:stackbite|helm)\.exe" %\*\r?\nexit \/b %errorlevel%\r?\n$/.exec(content);
  if (!match || !path.win32.isAbsolute(match.groups.home) || !path.win32.isAbsolute(match.groups.state)) return null;
  const relative = path.win32.relative(appRoot.toLowerCase(), path.win32.normalize(match.groups.home).toLowerCase());
  if (!relative || relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)) return null;
  return match.groups.state;
}
async function launcherText(filename) {
  try {
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) return null;
    const bytes = await readSmall(filename, 16384);
    const content = bytes.toString('utf8');
    if (content.includes('\uFFFD') && /^@echo off\r?\n(?:rem Stackbite managed launcher\r?\n)?setlocal\r?\nset "HELM_HOME=/.test(content)) {
      fail('Existing managed Windows launcher is not UTF-8; set HELM_STATE_DIR explicitly to preserve its state.');
    }
    return content;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function stateDirectory(environment = process.env, platform = process.platform, home = os.homedir()) {
  if (environment.HELM_STATE_DIR) return path.resolve(environment.HELM_STATE_DIR);
  if (platform === 'win32') {
    const local = environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    for (const name of ['default-install.json', 'install.json']) {
      let bytes;
      try { bytes = await readSmall(path.join(local, 'Helm', name), 16384); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      let config;
      try { config = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('Existing Helm install configuration is invalid'); }
      if (config && typeof config.state === 'string' && config.state && !/[\0\r\n]/.test(config.state)) return path.resolve(config.state);
    }
    const profile = environment.USERPROFILE || home;
    const appRoot = path.resolve(local, 'Helm', 'app');
    for (const name of ['stackbite.cmd', 'stackbite-portable.cmd', 'helm.cmd', 'helm-portable.cmd']) {
      const content = await launcherText(path.join(profile, '.local', 'bin', name));
      const state = content === null ? null : windowsManagedState(content, appRoot);
      if (state) return path.resolve(state);
    }
    return path.resolve(local, 'Helm', 'state');
  }
  const userHome = environment.HOME || home;
  for (const name of ['stackbite', 'helm']) {
    let bytes;
    try {
      const launcher = path.join(userHome, '.local', 'bin', name);
      const info = await fs.lstat(launcher);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) continue;
      bytes = await readSmall(launcher, 16384);
    }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const state = managedState(bytes.toString('utf8'));
    if (state) return path.resolve(state);
  }
  return path.resolve(environment.XDG_STATE_HOME || path.join(userHome, '.local', 'state'), 'helm');
}
function cacheDirectory(environment = process.env, platform = process.platform, home = os.homedir()) {
  return platform === 'win32'
    ? path.resolve(environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Stackbite', 'cache')
    : path.resolve(environment.XDG_CACHE_HOME || path.join(environment.HOME || home, '.cache'), 'stackbite');
}
module.exports = { shellLiteral, managedState, windowsManagedState, stateDirectory, cacheDirectory };
