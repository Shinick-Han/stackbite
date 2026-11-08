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
    const captured = await captureShim(shim, entry, relative);
    if (captured) shims.push(captured);
  }
  if (!shims.length) return null;
  const recovery = recoveryModule(root, platform, node, cli, recoveryOptions);
  const files = [];
  for (const [file, data] of [[path.join(root, 'package.json'), metadata], [entry, entryData],
    [path.join(root, 'packaging/npm/lib/bootstrap.js'), recovery],
    [path.join(root, 'packaging/npm/lib/uninstall-registration.js'), await fs.readFile(__filename)]]) {
    files.push(await captureFile(file, data));
  }
  return { root, info: await fs.lstat(root), prefix, prefixInfo: await fs.lstat(prefix), shims, files };
}

// The file's current identity (undefined when absent) with the bytes to restore.
async function captureFile(file, data) {
  await commandParent(file);
  let info;
  try { info = await fs.lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('Linked npm command preserved');
  return { path: file, info, data };
}

// An absent shim is null. A present one must link or point to this package's entry.
async function captureShim(shim, entry, relative) {
  await commandParent(shim);
  let info;
  try { info = await fs.lstat(shim); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink()) {
    const target = await fs.readlink(shim);
    if (path.resolve(path.dirname(shim), target) !== entry) throw new Error('Foreign npm command preserved');
    return { path: shim, info, target };
  }
  const data = await fs.readFile(shim);
  if (!info.isFile() || info.nlink !== 1 || data.length > 128 * 1024 || !data.toString('utf8').replaceAll('\\', '/').includes(relative)) throw new Error('Foreign npm command preserved');
  return { path: shim, info, data };
}

// Only the current global package's exact POSIX npm link is not a native
// launcher. Regular files remain legacy candidates, even at this same name.
async function ownCommandLink(file, packageRoot, platform) {
  if (platform === 'win32') return false;
  const prefix = await registration(packageRoot, platform);
  if (prefix === null || file !== path.join(prefix, 'bin', 'stackbite')) return false;
  const before = await fs.lstat(file);
  if (!before.isSymbolicLink() || before.nlink !== 1) return false;
  const relative = 'packaging/npm/bin/stackbite.js';
  const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (!metadata.bin || Object.keys(metadata.bin).length !== 1 || metadata.bin.stackbite !== relative) return false;
  const entry = path.join(packageRoot, relative);
  const target = await fs.readlink(file);
  // Do not collapse target components: POSIX follows redirect/.. before
  // applying the parent hop. Only npm's direct relative or absolute spelling
  // uses exclusively the command/package parents verified below.
  if (target !== path.relative(path.dirname(file), entry) && target !== entry) return false;
  await commandParent(entry);
  const info = await fs.lstat(entry);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return false;
  const captured = await captureShim(file, entry, relative);
  const after = await fs.lstat(file);
  return captured && sameIdentity(before, captured.info) && sameIdentity(before, after)
    && after.isSymbolicLink() && after.nlink === 1;
}

// The bootstrap.js replacement that lets the original bin finish registration-only removal.
function recoveryModule(root, platform, node, cli, recoveryOptions) {
  const options = JSON.stringify({ packageRoot: root, platform, nodeExecutable: node, npmCli: cli,
    installRoot: recoveryOptions.installRoot, cache: recoveryOptions.cache });
  return Buffer.from(`const m=require('./uninstall-registration'),cp=require('node:child_process');\nconst launch=async(exe,args,env)=>{const r=cp.spawnSync(exe,args,{env,stdio:'inherit'});if(r.error)throw r.error;return {code:r.status,signal:r.signal};};\nmodule.exports.main=async()=>{const r=await m.registrationOnly(process.argv.slice(2),process.env,launch,${options});if(!r)throw Error('Native removal remains incomplete');return r;};\n`);
}

async function restoreCommand(backup) {
  if (!backup) return;
  const info = await fs.lstat(backup.root);
  if (info.dev !== backup.info.dev || info.ino !== backup.info.ino) throw new Error('npm registration replaced; preserved');
  const prefix = await fs.lstat(backup.prefix);
  if (prefix.dev !== backup.prefixInfo.dev || prefix.ino !== backup.prefixInfo.ino) throw new Error('npm prefix replaced; preserved');
  const items = [...backup.files, ...backup.shims];
  for (const item of items) await assertRestorable(item);
  for (const item of items) {
    if (item.target) {
      try { await fs.lstat(item.path); } catch (error) { if (error.code !== 'ENOENT') throw error; await fs.symlink(item.target, item.path); }
    } else await restoreFile(item);
  }
}

// A present item is still the captured object; a file is still unlinked.
async function assertRestorable(item) {
  await commandParent(item.path);
  try {
    const current = await fs.lstat(item.path);
    if (!item.info || current.dev !== item.info.dev || current.ino !== item.info.ino) throw new Error('npm command replaced; preserved');
    if (!item.target && (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1)) throw new Error('Linked npm command preserved');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function restoreFile(item) {
  // An npm partial uninstall can leave this original bin read/share-only.
  // Its existing require('../lib/bootstrap') reaches the small recovery module.
  try { if ((await fs.readFile(item.path)).equals(item.data)) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(item.path), { recursive: true });
  await commandParent(item.path);
  const file = await fs.open(item.path, require('node:fs').constants.O_WRONLY | require('node:fs').constants.O_CREAT
    | require('node:fs').constants.O_TRUNC | (require('node:fs').constants.O_NOFOLLOW || 0), 0o755);
  try { await file.writeFile(item.data); } finally { await file.close(); }
  await fs.chmod(item.path, 0o755);
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

const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;

// The user's home and the data directory that holds the canonical installation root.
function productData(environment, platform) {
  const home = (platform === 'win32' ? environment.USERPROFILE || environment.HOME : environment.HOME) || require('node:os').homedir();
  const data = platform === 'win32' ? environment.LOCALAPPDATA || home
    : environment.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return { home, data };
}

// Every location an installed native product could occupy. Registration-only
// removal is allowed only when all of them are absent or empty directory shells.
function nativeLocations(environment, platform, prefix, options) {
  const { home, data } = productData(environment, platform);
  const canonical = path.join(data, platform === 'win32' ? 'Stackbite' : 'stackbite');
  const root = options.installRoot || canonical;
  const old = path.join(data, platform === 'win32' ? 'Helm' : 'helm');
  const legacyNames = ['app', 'cache', 'state', 'default-install.json', 'install.json'];
  // Keep this recovery module standalone after npm removes the other modules.
  // This is cache.js's npm namespace, not Python's locator/control fallback.
  const npmData = environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roots = [root, ...legacyNames.map(name => path.join(old, name)),
    ...(platform === 'win32' ? [path.join(npmData, 'Stackbite'), ...legacyNames.map(name => path.join(npmData, 'Helm', name))] : []),
    ...(platform === 'win32' ? [] : ['stackbite', 'helm'].flatMap(name => [
      path.join(environment.XDG_STATE_HOME || path.join(home, '.local', 'state'), name),
      path.join(environment.XDG_CACHE_HOME || path.join(home, '.cache'), name)])),
    ...[options.cache, environment.STACKBITE_HOME, environment.STACKBITE_STATE_DIR].filter(Boolean)];
  const commands = platform === 'win32' ? ['stackbite.cmd', 'stackbite-portable.cmd', 'stackbite.exe', 'stackbite.exe.next'] : ['stackbite'];
  for (const name of commands) {
    const native = path.join(home, '.local', 'bin', name);
    const own = platform === 'win32' ? path.join(prefix, name) : path.join(prefix, 'bin', name);
    if (native !== own) roots.push(native);
  }
  return { root, canonical, roots: [...new Set(roots)] };
}

// True when `start` and each ancestor is a real, unlinked directory outside a Git checkout.
async function plainDirectoryChain(start) {
  for (let parent = start; ; parent = path.dirname(parent)) {
    const info = await fs.lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(parent) !== parent) return false;
    try { await fs.lstat(path.join(parent, '.git')); return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (parent === path.dirname(parent)) return true;
  }
}

async function ancestorsAreDirectories(location) {
  for (let parent = path.dirname(location); ; parent = path.dirname(parent)) {
    try { const info = await fs.lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (parent === path.dirname(parent)) return true;
  }
}

// A first-ever publisher pins this existing control object across download.
// Unlinking its verified name invalidates that publisher; this FD is no mutex.
// Returns null when there is no preparation, false when it is not ours to remove.
async function openPreparation(root, canonical) {
  const directory = path.join(root, '.stackbite-update'), file = path.join(directory, 'update.lock');
  let info;
  try { info = await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (root !== canonical || !path.isAbsolute(root) || path.resolve(root) !== root
      || root.split(path.sep).includes('..') || /[\0\r\n]/.test(root)
      || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 1n) return false;
  try {
    if (!await plainDirectoryChain(directory)) return false;
    const { constants } = require('node:fs');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const preparation = { root, file, directory, info, handle };
    try {
      preparation.rootInfo = await fs.lstat(root, { bigint: true });
      preparation.directoryInfo = await fs.lstat(directory, { bigint: true });
    } catch (error) { await handle.close(); throw error; }
    return preparation;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The held lock is still the same single-link file holding nothing or the byte '0'.
async function preparationCurrent(preparation) {
  const held = await preparation.handle.stat({ bigint: true });
  const current = await fs.lstat(preparation.file, { bigint: true });
  const bytes = Buffer.alloc(2);
  const { bytesRead } = await preparation.handle.read(bytes, 0, bytes.length, 0);
  return held.isFile() && current.isFile() && !current.isSymbolicLink()
    && held.nlink === 1n && current.nlink === 1n && sameIdentity(held, preparation.info) && sameIdentity(current, held)
    && held.size <= 1n && current.size === held.size && BigInt(bytesRead) === held.size
    && (bytesRead === 0 || bytesRead === 1 && bytes[0] === 0x30);
}

async function preparationUnchanged(preparation) {
  if (!await plainDirectoryChain(preparation.directory)) return false;
  for (const [directory, expected, names] of [
    [preparation.root, preparation.rootInfo, ['.stackbite-update']],
    [preparation.directory, preparation.directoryInfo, ['update.lock']],
  ]) {
    const info = await fs.lstat(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || !sameIdentity(info, expected)
        || await fs.realpath(directory) !== directory
        || JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify(names)) return false;
  }
  return preparationCurrent(preparation);
}

// Directory shells left by a completed physical tail contain no artifacts.
// The pinned canonical preparation is the only permitted file.
async function emptyLocation(location, preparation) {
  try {
    const info = await fs.lstat(location);
    if (preparation && location === preparation.file) return preparationCurrent(preparation);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(location) !== path.resolve(location)) return false;
    for (const name of await fs.readdir(location)) if (!await emptyLocation(path.join(location, name), preparation)) return false;
    return true;
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function removePreparation(preparation) {
  await fs.unlink(preparation.file);
  for (const [location, expected] of [[preparation.directory, preparation.directoryInfo], [preparation.root, preparation.rootInfo]]) {
    const current = await fs.lstat(location, { bigint: true });
    if (!sameIdentity(current, expected) || !current.isDirectory() || current.isSymbolicLink()
        || await fs.realpath(location) !== location) throw new Error('Installation preparation replaced; preserved');
    await fs.rmdir(location);
  }
}

async function registrationOnly(argv, environment, launch, options = {}) {
  if (!explicitApply(argv)) return null;
  const platform = options.platform || process.platform;
  const packageRoot = options.packageRoot || path.resolve(__dirname, '../../..');
  const prefix = await registration(packageRoot, platform);
  if (prefix === null) return null;
  const { root, canonical, roots } = nativeLocations(environment, platform, prefix, options);
  const preparation = await openPreparation(root, canonical);
  if (preparation === false) return null;
  try {
    if (preparation && !await preparationUnchanged(preparation)) return null;
    for (const location of roots) {
      const absolute = path.resolve(location);
      if (!await ancestorsAreDirectories(absolute) || !await emptyLocation(absolute, preparation)) return null;
    }
    if (preparation) {
      if (!await preparationUnchanged(preparation)) return null;
      await removePreparation(preparation);
    }
    return removeRegistration(argv, { code: 0, signal: null }, environment, launch, { ...options, packageRoot });
  } finally { if (preparation) await preparation.handle.close(); }
}

// Recovery never installs/downloads another runtime. Only the accepted journal's
// exact capsule can continue a partially removed product.
async function resumeWithoutRuntime(argv, environment, launch, options = {}) {
  if (!explicitApply(argv)) return null;
  const platform = options.platform || process.platform;
  const root = options.installRoot || path.join(productData(environment, platform).data, platform === 'win32' ? 'Stackbite' : 'stackbite');
  const journal = path.join(root, '.stackbite-uninstall.json');
  const record = await readRemovalJournal(journal);
  if (record === undefined) return null;
  if (record.schema !== 'stackbite.uninstall.v1' || !record.accepted || !record.processes_settled
      || record.install_identity?.root !== root) return null;
  // The capsule takes the existing installation/removal locks and owns all
  // journal mutation, including npm settlement. This reader never rewrites it.
  const recovery = recoveryCommand(record, journal, platform);
  if (recovery === null) return null;
  const { selected, helper, pin } = recovery;
  const info = await fs.lstat(helper);
  if (!await soleRegularFile(helper, info, 128 * 1024) || await sha256File(helper) !== pin.sha256) {
    throw new Error('Removal capsule changed; preserved');
  }
  if (platform !== 'win32') await assertShellCapsule(record, journal);
  return launch(selected[0], selected.slice(1), environment, options);
}

// The parsed journal; undefined when there is none.
async function readRemovalJournal(journal) {
  try {
    const info = await fs.lstat(journal);
    if (!await soleRegularFile(journal, info, 8 * 1024 * 1024)) throw new Error('Unsafe removal journal');
    return JSON.parse(await fs.readFile(journal, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

// A regular, singly linked file within `limit` bytes that is its own real path.
async function soleRegularFile(location, info, limit = Infinity) {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && !(info.size > limit)
    && await fs.realpath(location) === location;
}

async function sha256File(location) {
  return require('node:crypto').createHash('sha256').update(await fs.readFile(location)).digest('hex');
}

// The journal's recovery argv when it is exactly this platform's pinned helper invocation.
function recoveryCommand(record, journal, platform) {
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
  return { selected, helper, pin };
}

async function assertShellCapsule(record, journal) {
  const capsule = journal.replace(/\.json$/, '.cleanup');
  const pinned = record.helper_files.find(item => item.path === capsule);
  const current = await fs.lstat(capsule);
  if (!pinned || !await soleRegularFile(capsule, current) || await sha256File(capsule) !== pinned.sha256) {
    throw new Error('Removal capsule changed; preserved');
  }
  // Source invocations retain their existing interpreter/entry outside the
  // removal inventory. Validate those exact pins before executing the shell
  // capsule; neither environment PATH nor journal argv selects a runtime.
  if (record.source_cleanup_pins !== undefined) await assertSourceCleanupPins(record.source_cleanup_pins);
}

async function assertSourceCleanupPins(pins) {
  if (!Array.isArray(pins) || pins.length !== 4) {
    throw new Error('Source cleanup identity changed');
  }
  for (const pin of pins) {
    const location = pin.path;
    if (typeof location !== 'string' || !path.isAbsolute(location) || /[\x00\r\n]/.test(location)
        || location.split(path.sep).includes('..')) throw new Error('Source cleanup runtime changed');
    const current = await fs.lstat(location);
    if (!await soleRegularFile(location, current) || current.dev !== pin.identity?.device
        || current.ino !== pin.identity?.inode || await sha256File(location) !== pin.sha256) {
      throw new Error('Source cleanup runtime changed');
    }
  }
}

module.exports = { registration, npmProgram, removeRegistration, explicitApply, descriptor, resumeWithoutRuntime, registrationOnly, ownCommandLink };
