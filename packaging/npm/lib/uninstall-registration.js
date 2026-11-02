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
  const packageFile = path.join(root, 'package.json'), packageInfo = await fs.lstat(packageFile);
  await commandParent(packageFile);
  if (await projectLocalPackage(root)) throw new Error('Source npm package preserved');
  if (!packageInfo.isFile() || packageInfo.isSymbolicLink() || packageInfo.nlink !== 1) throw new Error('Linked npm package registration preserved');
  const metadata = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  if (metadata.name !== 'stackbite') throw new Error('Foreign npm package registration preserved');
  // npx owns its own cache, which is not a global registration.
  const prefix = globalPrefix(modules, platform);
  if (prefix === null || await projectLocal(prefix)) return null;
  return prefix;
}

async function projectLocalPackage(root) {
  try { await fs.lstat(path.join(root, '.git')); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
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
  const backup = await captureCommand(root, prefix, options.platform || process.platform, node, cli, options);
  const removed = await launch(node, [cli, 'uninstall', '--global', '--prefix', prefix,
    'stackbite', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
  { ...environment, npm_config_update_notifier: 'false' }, options);
  let remains;
  try { await fs.lstat(root); remains = true; } catch (error) { if (error.code !== 'ENOENT') throw error; remains = false; }
  if (remains) {
    await restoreCommand(backup);
    throw new Error('Product removal was accepted; npm registration removal failed');
  }
  for (const item of backup?.shims || []) {
    try {
      const info = await fs.lstat(item.path);
      if (info.dev === item.info.dev && info.ino === item.info.ino) await fs.unlink(item.path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // npm can fail after removing its last owned file. Physical absence settles it.
  void removed;
  return result;
}

async function captureCommand(root, prefix, platform, node, cli, recoveryOptions) {
  const metadata = await fs.readFile(path.join(root, 'package.json'));
  const relative = 'packaging/npm/bin/stackbite.js';
  const bins = JSON.parse(metadata).bin;
  if (!bins || Object.keys(bins).length !== 1 || bins.stackbite !== relative) return null;
  const entry = path.join(root, relative), shims = [];
  await commandParent(entry);
  const entryInfo = await fs.lstat(entry);
  if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || entryInfo.nlink !== 1) throw new Error('Linked npm command preserved');
  const entryData = await fs.readFile(entry);
  for (const shim of platform === 'win32' ? ['stackbite', 'stackbite.cmd', 'stackbite.ps1'].map(name => path.join(prefix, name)) : [path.join(prefix, 'bin', 'stackbite')]) {
    await commandParent(shim);
    let info;
    try { info = await fs.lstat(shim); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) {
      const target = await fs.readlink(shim);
      if (path.resolve(path.dirname(shim), target) !== entry) throw new Error('Foreign npm command preserved');
      shims.push({ path: shim, info, target });
    } else {
      const data = await fs.readFile(shim);
      if (!info.isFile() || info.nlink !== 1 || data.length > 128 * 1024 || !data.toString('utf8').replaceAll('\\', '/').includes(relative)) throw new Error('Foreign npm command preserved');
      shims.push({ path: shim, info, data });
    }
  }
  if (!shims.length) return null;
  const options = JSON.stringify({ packageRoot: root, platform, nodeExecutable: node, npmCli: cli,
    installRoot: recoveryOptions.installRoot, cache: recoveryOptions.cache });
  const recovery = Buffer.from(`const m=require('./uninstall-registration'),cp=require('node:child_process');\nconst launch=async(exe,args,env)=>{const r=cp.spawnSync(exe,args,{env,stdio:'inherit'});if(r.error)throw r.error;return {code:r.status,signal:r.signal};};\nmodule.exports.main=async()=>{const r=await m.registrationOnly(process.argv.slice(2),process.env,launch,${options});if(!r)throw Error('Native removal remains incomplete');return r;};\n`);
  const files = [];
  for (const [file, data] of [[path.join(root, 'package.json'), metadata], [entry, entryData],
    [path.join(root, 'packaging/npm/lib/bootstrap.js'), recovery],
    [path.join(root, 'packaging/npm/lib/uninstall-registration.js'), await fs.readFile(__filename)]]) {
    await commandParent(file);
    let info;
    try { info = await fs.lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('Linked npm command preserved');
    files.push({ path: file, info, data });
  }
  return { root, info: await fs.lstat(root), prefix, prefixInfo: await fs.lstat(prefix), shims, files };
}

async function restoreCommand(backup) {
  if (!backup) return;
  const info = await fs.lstat(backup.root);
  if (info.dev !== backup.info.dev || info.ino !== backup.info.ino) throw new Error('npm registration replaced; preserved');
  const prefix = await fs.lstat(backup.prefix);
  if (prefix.dev !== backup.prefixInfo.dev || prefix.ino !== backup.prefixInfo.ino) throw new Error('npm prefix replaced; preserved');
  const items = [...backup.files, ...backup.shims];
  for (const item of items) {
    await commandParent(item.path);
    try {
      const current = await fs.lstat(item.path);
      if (!item.info || current.dev !== item.info.dev || current.ino !== item.info.ino) throw new Error('npm command replaced; preserved');
      if (!item.target && (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1)) throw new Error('Linked npm command preserved');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const item of items) {
    if (item.target) {
      try { await fs.lstat(item.path); } catch (error) { if (error.code !== 'ENOENT') throw error; await fs.symlink(item.target, item.path); }
    } else {
      // An npm partial uninstall can leave this original bin read/share-only.
      // Its existing require('../lib/bootstrap') reaches the small recovery module.
      try { if ((await fs.readFile(item.path)).equals(item.data)) continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.mkdir(path.dirname(item.path), { recursive: true });
      await commandParent(item.path);
      const file = await fs.open(item.path, require('node:fs').constants.O_WRONLY | require('node:fs').constants.O_CREAT
        | require('node:fs').constants.O_TRUNC | (require('node:fs').constants.O_NOFOLLOW || 0), 0o755);
      try { await file.writeFile(item.data); } finally { await file.close(); }
      await fs.chmod(item.path, 0o755);
    }
  }
}

async function commandParent(file) {
  for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
    try { const info = await fs.lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked npm command preserved'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (parent === path.dirname(parent)) return;
  }
}

function acceptedRemoval(argv, result) {
  return explicitApply(argv) && !result.signal && [0, 2].includes(result.code);
}

function explicitApply(argv) {
  const allowed = new Set(['--all', '--keep-data', '--resume', '--apply', '--yes']);
  return ['uninstall', 'delete'].includes(argv[0]) && argv.slice(1).every(arg => allowed.has(arg))
    && !(argv.includes('--all') && argv.includes('--keep-data'))
    && !(argv.includes('--resume') && (argv.includes('--all') || argv.includes('--keep-data')));
}

async function descriptor(options = {}) {
  const root = options.packageRoot || path.resolve(__dirname, '../../..');
  const prefix = await registration(root, options.platform || process.platform);
  if (prefix === null) return null;
  const node = options.nodeExecutable || process.execPath;
  return { root, prefix, node: await fs.realpath(node), cli: await fs.realpath(options.npmCli || npmProgram(root, node)) };
}

function windowsCleanupCommand(helper, pin) {
  const encoded = Buffer.from(helper, 'utf8').toString('base64');
  const dispatch = "& { $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded
    + "')); $b=[IO.File]::ReadAllBytes($p); $s=[Security.Cryptography.SHA256]::Create(); try { "
    + "$h=[BitConverter]::ToString($s.ComputeHash($b)).Replace('-','').ToLowerInvariant() "
    + "} finally { $s.Dispose() }; if ($h -ne '" + pin.sha256 + "') { throw 'Removal capsule changed' }; "
    + "& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xfeff))) }";
  return ['powershell.exe', '-NoProfile', '-Command', dispatch];
}

async function registrationOnly(argv, environment, launch, options = {}) {
  if (!explicitApply(argv)) return null;
  const platform = options.platform || process.platform;
  const packageRoot = options.packageRoot || path.resolve(__dirname, '../../..');
  const prefix = await registration(packageRoot, platform);
  if (prefix === null) return null;
  const home = (platform === 'win32' ? environment.USERPROFILE || environment.HOME : environment.HOME) || require('node:os').homedir();
  const data = platform === 'win32' ? environment.LOCALAPPDATA || home
    : environment.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const root = options.installRoot || path.join(data, platform === 'win32' ? 'Stackbite' : 'stackbite');
  const canonical = path.join(data, platform === 'win32' ? 'Stackbite' : 'stackbite');
  const old = path.join(data, platform === 'win32' ? 'Helm' : 'helm');
  // Keep this recovery module standalone after npm removes the other modules.
  // This is cache.js's npm namespace, not Python's locator/control fallback.
  const npmData = environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roots = [root, ...['app', 'cache', 'state', 'default-install.json', 'install.json'].map(name => path.join(old, name)),
    ...(platform === 'win32' ? [path.join(npmData, 'Stackbite'),
      ...['app', 'cache', 'state', 'default-install.json', 'install.json'].map(name =>
        path.join(npmData, 'Helm', name))] : []),
    ...(platform === 'win32' ? [] : ['stackbite', 'helm'].flatMap(name => [
      path.join(environment.XDG_STATE_HOME || path.join(home, '.local', 'state'), name),
      path.join(environment.XDG_CACHE_HOME || path.join(home, '.cache'), name)])),
    ...[options.cache, environment.STACKBITE_HOME, environment.STACKBITE_STATE_DIR].filter(Boolean)];
  // Directory shells left by a completed physical tail contain no artifacts.
  // The pinned canonical preparation below is the only permitted file.
  let preparation, preparationHandle;
  async function empty(location) {
    try {
      const info = await fs.lstat(location);
      if (preparation && location === preparation.file) return preparationCurrent();
      if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(location) !== path.resolve(location)) return false;
      for (const name of await fs.readdir(location)) if (!await empty(path.join(location, name))) return false;
      return true;
    } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  async function preparationCurrent() {
    const held = await preparation.handle.stat({ bigint: true });
    const current = await fs.lstat(preparation.file, { bigint: true });
    const bytes = Buffer.alloc(2);
    const { bytesRead } = await preparation.handle.read(bytes, 0, bytes.length, 0);
    return held.isFile() && current.isFile() && !current.isSymbolicLink()
      && held.nlink === 1n && current.nlink === 1n && same(held, preparation.info) && same(current, held)
      && held.size <= 1n && current.size === held.size && BigInt(bytesRead) === held.size
      && (bytesRead === 0 || bytesRead === 1 && bytes[0] === 0x30);
  }
  async function preparationDirectories() {
    for (let parent = preparation.directory; ; parent = path.dirname(parent)) {
      const info = await fs.lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(parent) !== parent) return false;
      try { await fs.lstat(path.join(parent, '.git')); return false; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (parent === path.dirname(parent)) break;
    }
    for (const [directory, expected, names] of [
      [root, preparation.rootInfo, ['.stackbite-update']],
      [preparation.directory, preparation.directoryInfo, ['update.lock']],
    ]) {
      const info = await fs.lstat(directory, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || !same(info, expected)
          || await fs.realpath(directory) !== directory
          || JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify(names)) return false;
    }
    return preparationCurrent();
  }
  // A first-ever publisher pins this existing control object across download.
  // Unlinking its verified name invalidates that publisher; this FD is no mutex.
  const directory = path.join(root, '.stackbite-update'), file = path.join(directory, 'update.lock');
  try {
    try {
      const info = await fs.lstat(file, { bigint: true });
      if (root !== canonical || !path.isAbsolute(root) || path.resolve(root) !== root
          || root.split(path.sep).includes('..') || /[\0\r\n]/.test(root)
          || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 1n) return null;
      for (let parent = directory; ; parent = path.dirname(parent)) {
        const parentInfo = await fs.lstat(parent);
        if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await fs.realpath(parent) !== parent) return null;
        try { await fs.lstat(path.join(parent, '.git')); return null; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (parent === path.dirname(parent)) break;
      }
      preparationHandle = await fs.open(file, require('node:fs').constants.O_RDONLY | (require('node:fs').constants.O_NOFOLLOW || 0));
      preparation = { file, directory, info, handle: preparationHandle, rootInfo: await fs.lstat(root, { bigint: true }),
        directoryInfo: await fs.lstat(directory, { bigint: true }) };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (preparation && !await preparationDirectories()) return null;
    const commands = platform === 'win32' ? ['stackbite.cmd', 'stackbite-portable.cmd', 'stackbite.exe', 'stackbite.exe.next'] : ['stackbite'];
    for (const name of commands) {
      const native = path.join(home, '.local', 'bin', name);
      const own = platform === 'win32' ? path.join(prefix, name) : path.join(prefix, 'bin', name);
      if (native !== own) roots.push(native);
    }
    for (const location of new Set(roots)) {
      const absolute = path.resolve(location);
      for (let parent = path.dirname(absolute); ; parent = path.dirname(parent)) {
        try { const info = await fs.lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) return null; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (parent === path.dirname(parent)) break;
      }
      if (!await empty(absolute)) return null;
    }
    if (preparation) {
      if (!await preparationDirectories()) return null;
      await fs.unlink(preparation.file);
      for (const [location, expected] of [[directory, preparation.directoryInfo], [root, preparation.rootInfo]]) {
        const current = await fs.lstat(location, { bigint: true });
        if (!same(current, expected) || !current.isDirectory() || current.isSymbolicLink()
            || await fs.realpath(location) !== location) throw new Error('Installation preparation replaced; preserved');
        await fs.rmdir(location);
      }
    }
    return removeRegistration(argv, { code: 0, signal: null }, environment, launch, { ...options, packageRoot });
  } finally { if (preparationHandle) await preparationHandle.close(); }
}

// Recovery never installs/downloads another runtime. Only the accepted journal's
// exact capsule can continue a partially removed product.
async function resumeWithoutRuntime(argv, environment, launch, options = {}) {
  if (!explicitApply(argv)) return null;
  const platform = options.platform || process.platform;
  const home = (platform === 'win32' ? environment.USERPROFILE || environment.HOME : environment.HOME) || require('node:os').homedir();
  const root = options.installRoot || (platform === 'win32'
    ? path.join(environment.LOCALAPPDATA || home, 'Stackbite')
    : path.join(environment.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'stackbite'));
  const journal = path.join(root, '.stackbite-uninstall.json');
  let record;
  try {
    const info = await fs.lstat(journal);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024
        || await fs.realpath(journal) !== journal) throw new Error('Unsafe removal journal');
    record = JSON.parse(await fs.readFile(journal, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (record.schema !== 'stackbite.uninstall.v1' || !record.accepted || !record.processes_settled
      || record.install_identity?.root !== root) return null;
  // The capsule takes the existing installation/removal locks and owns all
  // journal mutation, including npm settlement. This reader never rewrites it.
  const command = record.recovery_command;
  const suffix = platform === 'win32' ? '.ps1' : '.sh';
  const helper = journal.replace(/\.json$/, suffix);
  const pin = record.helper_files?.find(item => item.path === helper);
  if (!pin) return null;
  const expected = platform === 'win32' ? windowsCleanupCommand(helper, pin) : ['sh', helper];
  const legacy = ['powershell.exe', '-NoProfile', '-File', helper];
  const selected = platform === 'win32' && JSON.stringify(command) === JSON.stringify(legacy) ? legacy : expected;
  if (!Array.isArray(command) || JSON.stringify(command) !== JSON.stringify(selected)
      || !record.helper_files?.some(item => item.path === helper)) return null;
  const info = await fs.lstat(helper);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128 * 1024
      || await fs.realpath(helper) !== helper
      || require('node:crypto').createHash('sha256').update(await fs.readFile(helper)).digest('hex') !== pin.sha256) {
    throw new Error('Removal capsule changed; preserved');
  }
  if (platform !== 'win32') {
    const capsule = journal.replace(/\.json$/, '.cleanup');
    const pinned = record.helper_files.find(item => item.path === capsule);
    const current = await fs.lstat(capsule);
    if (!pinned || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || await fs.realpath(capsule) !== capsule
        || require('node:crypto').createHash('sha256').update(await fs.readFile(capsule)).digest('hex') !== pinned.sha256) {
      throw new Error('Removal capsule changed; preserved');
    }
    // Source invocations retain their existing interpreter/entry outside the
    // removal inventory. Validate those exact pins before executing the shell
    // capsule; neither environment PATH nor journal argv selects a runtime.
    if (record.source_cleanup_pins !== undefined) {
      if (!Array.isArray(record.source_cleanup_pins) || record.source_cleanup_pins.length !== 4) {
        throw new Error('Source cleanup identity changed');
      }
      for (const pin of record.source_cleanup_pins) {
        const location = pin.path;
        if (typeof location !== 'string' || !path.isAbsolute(location) || /[\x00\r\n]/.test(location)
            || location.split(path.sep).includes('..')) throw new Error('Source cleanup runtime changed');
        const current = await fs.lstat(location);
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
            || await fs.realpath(location) !== location || current.dev !== pin.identity?.device
            || current.ino !== pin.identity?.inode
            || require('node:crypto').createHash('sha256').update(await fs.readFile(location)).digest('hex') !== pin.sha256) {
          throw new Error('Source cleanup runtime changed');
        }
      }
    }
  }
  return launch(selected[0], selected.slice(1), environment, options);
}

module.exports = { registration, npmProgram, removeRegistration, explicitApply, descriptor, resumeWithoutRuntime, registrationOnly };
