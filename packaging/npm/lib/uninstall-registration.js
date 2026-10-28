'use strict';
// Let npm remove only this exact global registration. Never delete a shared prefix.
const fs = require('node:fs/promises');
const path = require('node:path');

async function registration(packageRoot, platform = process.platform) {
  const root = path.resolve(packageRoot);
  const modules = path.dirname(root);
  if (path.basename(root) !== 'stackbite' || path.basename(modules) !== 'node_modules') return null;
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(root) !== root) {
    throw new Error('Linked npm registration preserved; remove it through its original package manager');
  }
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== 'stackbite') throw new Error('Foreign npm package registration preserved');
  // npx owns its own cache, which is not a global registration.
  const prefix = globalPrefix(modules, platform);
  if (prefix === null || await projectLocal(prefix)) return null;
  return prefix;
}

function globalPrefix(modules, platform) {
  const prefix = path.dirname(modules);
  if (prefix.split(path.sep).includes('_npx')) return null;
  if (platform === 'win32') return prefix;
  return path.basename(prefix) === 'lib' ? path.dirname(prefix) : null;
}

async function projectLocal(prefix) {
  // A project-local node_modules tree is source, even when its package name matches.
  for (const name of ['package.json', '.git']) {
    try { await fs.lstat(path.join(prefix, name)); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

function npmProgram(packageRoot, nodeExecutable, resolve = require.resolve) {
  const metadata = resolve('npm/package.json', { paths: [packageRoot, path.dirname(nodeExecutable)] });
  return path.join(path.dirname(metadata), 'bin', 'npm-cli.js');
}

async function removeRegistration(argv, result, environment, launch, options = {}) {
  if (!acceptedRemoval(argv, result)) return result;
  const root = options.packageRoot || path.resolve(__dirname, '../../..');
  const prefix = await registration(root, options.platform || process.platform);
  if (prefix === null) return result;
  const node = options.nodeExecutable || process.execPath;
  const cli = options.npmCli || npmProgram(root, node);
  const removed = await launch(node, [cli, 'uninstall', '--global', '--prefix', prefix,
    'stackbite', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
  { ...environment, npm_config_update_notifier: 'false' }, options);
  if (removed.code !== 0 || removed.signal) throw new Error('Product removal was accepted; npm registration removal failed');
  return result;
}

function acceptedRemoval(argv, result) {
  return explicitApply(argv) && !result.signal && [0, 2].includes(result.code);
}

function explicitApply(argv) {
  const choices = new Set(['--all', '--keep-data', '--resume']);
  return argv.length === 3 && ['uninstall', 'delete'].includes(argv[0])
    && argv.slice(1).includes('--apply') && argv.slice(1).some(arg => choices.has(arg));
}

module.exports = { registration, npmProgram, removeRegistration, explicitApply };
