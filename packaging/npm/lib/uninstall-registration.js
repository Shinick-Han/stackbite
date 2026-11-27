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

// The npm CLI that the current Node runs. Node, the global prefix and npm can
// live in three separate roots. A candidate comes from, in order: module
// resolution from the package and Node, the registration prefix, npm's own
// npm_execpath, the Node distribution layout and the first npm shim on PATH.
// No string qualifies by itself: the candidate must be the real
// bin/npm-cli.js that a real npm package's metadata names as its `npm` bin.
// Shims are read, never run. Throws STACKBITE_NPM_CLI_UNAVAILABLE.
async function npmProgram(packageRoot, nodeExecutable, options = {}) {
  const { cli, checked } = await locateNpm(packageRoot, nodeExecutable, options);
  if (cli) return cli;
  const error = new Error('No verified npm CLI was found (checked '
    + checked.map(item => `${item.kind}: ${item.reason}`).join(', ') + ')');
  error.code = 'STACKBITE_NPM_CLI_UNAVAILABLE';
  error.checked = checked;
  throw error;
}

async function locateNpm(packageRoot, nodeExecutable, options = {}) {
  const io = options.io || fs;
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const resolve = options.resolve || require.resolve;
  const windows = platform === 'win32';
  const checked = [];
  const prefixRoot = options.prefix ? (windows ? path.join(options.prefix, 'node_modules', 'npm')
    : path.join(options.prefix, 'lib', 'node_modules', 'npm')) : null;
  const nodeRoot = async () => {
    const node = await io.realpath(nodeExecutable);
    if (!(await io.lstat(node)).isFile()) throw npmRejected('node is not a file');
    return windows ? path.join(path.dirname(node), 'node_modules', 'npm')
      : path.join(path.dirname(path.dirname(node)), 'lib', 'node_modules', 'npm');
  };
  const candidates = [
    ['resolve', async () => {
      let metadata;
      // Node's ancestor node_modules walk can reach a directory that another
      // local user may create (C:\node_modules). Any resolution failure,
      // including a foreign package's exports, rejects only this candidate.
      try { metadata = resolve('npm/package.json', { paths: [packageRoot, path.dirname(nodeExecutable)] }); }
      catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') return null;
        throw npmRejected(`module resolution failed (${typeof error.code === 'string' ? error.code : 'error'})`);
      }
      if (typeof metadata !== 'string' || !path.isAbsolute(metadata)) throw npmRejected('module resolution failed (path)');
      // Only this registration's own npm or the running Node distribution's npm qualifies here.
      const found = await io.realpath(path.dirname(metadata));
      const allowed = [];
      for (const expected of [() => prefixRoot, nodeRoot]) {
        try { const root = await expected(); if (root) allowed.push(await io.realpath(root)); }
        catch (error) { if (!error.npmRejected && !['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw error; }
      }
      if (!allowed.some(root => samePath(root, found, windows))) throw npmRejected('resolved npm is outside the prefix and Node distribution');
      return verifiedNpmRoot(found, io);
    }],
    ['prefix', () => prefixRoot ? verifiedNpmRoot(prefixRoot, io) : null],
    ['npm_execpath', () => environment.npm_execpath ? verifiedNpmCli(environment.npm_execpath, io) : null],
    ['node', async () => verifiedNpmRoot(await nodeRoot(), io)],
    ['PATH', () => pathShim(environment, windows, io)],
  ];
  for (const [kind, candidate] of candidates) {
    let cli = null;
    try { cli = await candidate(); }
    catch (error) {
      if (!error.npmRejected && !['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EISDIR'].includes(error.code)) throw error;
      checked.push({ kind, reason: error.npmRejected ? error.message : (error.code === 'ENOENT' ? 'absent' : error.code) });
      continue;
    }
    if (cli) return { cli, checked: [...checked, { kind, reason: 'verified' }] };
    checked.push({ kind, reason: 'absent' });
  }
  return { cli: null, checked };
}

const samePath = (a, b, windows) => windows ? a.toLowerCase() === b.toLowerCase() : a === b;

function npmRejected(reason) {
  const error = new Error(reason);
  error.npmRejected = true;
  return error;
}

// The real bin/npm-cli.js of the npm package at `directory`.
async function verifiedNpmRoot(directory, io) {
  const root = await io.realpath(directory);
  const metadataFile = path.join(root, 'package.json');
  const info = await io.lstat(metadataFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw npmRejected('npm metadata is not a file');
  let metadata;
  try { metadata = JSON.parse(await io.readFile(metadataFile, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw npmRejected('npm metadata is not JSON'); throw error; }
  const bin = metadata && typeof metadata.bin === 'object' && metadata.bin !== null ? metadata.bin.npm : undefined;
  if (metadata?.name !== 'npm' || typeof metadata.version !== 'string' || typeof bin !== 'string'
      || path.posix.normalize(bin.replaceAll('\\', '/')) !== 'bin/npm-cli.js') throw npmRejected('npm metadata mismatch');
  const cli = path.join(root, 'bin', 'npm-cli.js');
  const cliInfo = await io.lstat(cli);
  if (!cliInfo.isFile() || cliInfo.isSymbolicLink() || await io.realpath(cli) !== cli) throw npmRejected('npm CLI target mismatch');
  return cli;
}

// An absolute CLI path (or link to it) accepted only as its npm package's own CLI.
async function verifiedNpmCli(file, io) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw npmRejected('npm CLI path is not absolute');
  const real = await io.realpath(file);
  if (path.basename(real) !== 'npm-cli.js' || path.basename(path.dirname(real)) !== 'bin') throw npmRejected('npm CLI target mismatch');
  if (await verifiedNpmRoot(path.dirname(path.dirname(real)), io) !== real) throw npmRejected('npm CLI target mismatch');
  return real;
}

// The CLI reference that npm's own generated shims (Node's npm.cmd/npm.ps1/npm
// and cmd-shim) spell, anchored to the shim's own directory: %~dp0 or %dp0% in
// npm.cmd, $PSScriptRoot or $basedir in npm.ps1, $basedir in an sh shim (Node's
// Windows sh shim spells its own directory $CLI_BASEDIR). POSIX script shims
// reach the prefix's lib/node_modules. Matched on one executable line only;
// nothing is parsed or run. A comment naming the path does not count.
const SHIM_ANCHORS = { 'npm.cmd': ['%~dp0', '%dp0%'], 'npm.ps1': ['$PSScriptRoot', '$basedir', '${basedir}'], npm: ['$basedir', '${basedir}'] };

function anchoredShim(name, body, windows) {
  const tail = (windows ? '' : '../lib/') + 'node_modules/npm/bin/npm-cli.js';
  const anchors = windows && name === 'npm' ? [...SHIM_ANCHORS.npm, '$CLI_BASEDIR', '${CLI_BASEDIR}'] : SHIM_ANCHORS[name];
  return body.split(/\r?\n/).some(line => {
    const text = line.trim();
    if (/^(?:#|::|rem(?:\s|$))/i.test(text)) return false;
    // The anchor starts a path token and is followed by its separator (%~dp0
    // already ends in one), exactly the CLI path and the token's end.
    return anchors.some(anchor => {
      for (let at = text.indexOf(anchor); at !== -1; at = text.indexOf(anchor, at + 1)) {
        if (at > 0 && !/["'=\s]/.test(text[at - 1])) continue;
        const after = text.slice(at + anchor.length);
        if (!anchor.startsWith('%') && !after.startsWith('/')) continue;
        const rest = after.replace(/^\/+/, '');
        if (rest.startsWith(tail) && /^(?:["'\s]|$)/.test(rest.slice(tail.length))) return true;
      }
      return false;
    });
  });
}

// Only the first PATH directory that holds an npm command is examined, as the
// shell would pick it. A link must reach the npm CLI; a script shim must hold
// npm's anchored CLI reference and that package must sit where npm puts it.
async function pathShim(environment, windows, io) {
  const key = Object.keys(environment).find(name => (windows ? name.toUpperCase() === 'PATH' : name === 'PATH'));
  const names = windows ? ['npm.cmd', 'npm.ps1', 'npm'] : ['npm'];
  for (const directory of (key ? String(environment[key]) : '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of names) {
      const shim = path.join(directory, name);
      let info;
      try { info = await io.lstat(shim); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
      if (info.isSymbolicLink()) return verifiedNpmCli(shim, io);
      if (!info.isFile() || info.size > 64 * 1024) throw npmRejected('npm shim is not a file');
      const body = (await io.readFile(shim)).toString('utf8').replaceAll('\\', '/');
      if (!anchoredShim(name, body, windows)) throw npmRejected('npm shim names no npm CLI');
      return verifiedNpmRoot(windows ? path.join(directory, 'node_modules', 'npm')
        : path.join(path.dirname(directory), 'lib', 'node_modules', 'npm'), io);
    }
  }
  return null;
}

async function removeRegistration(argv, result, environment, launch, options = {}) {
  if (!acceptedRemoval(argv, result)) return result;
  const root = options.packageRoot || path.resolve(__dirname, '../../..');
  const prefix = await registration(root, options.platform || process.platform);
  if (prefix === null) return result;
  const node = options.nodeExecutable || process.execPath;
  let cli = options.npmCli;
  if (!cli) {
    try { cli = await npmProgram(root, node, { ...options, environment, prefix }); }
    catch (error) {
      if (error.code !== 'STACKBITE_NPM_CLI_UNAVAILABLE') throw error;
      throw registrationRemains(prefix, error, options.platform || process.platform);
    }
  }
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

// Native removal completed and nothing of the npm command was touched: the
// registration stays an ordinary, removable npm package. The next action names
// the literal prefix, quoted for PowerShell on Windows and for a POSIX shell.
function registrationRemains(prefix, unavailable, platform) {
  const quoted = platform === 'win32' ? `'${prefix.replace(/['‘’‚‛]/g, quote => quote + quote)}'`
    : `'${prefix.replaceAll("'", "'\\''")}'`;
  const remains = new Error(`Stackbite native removal completed; the npm registration remains at ${prefix}. `
    + `${unavailable.message}. Remove it with: npm uninstall --global --prefix ${quoted} stackbite`);
  remains.code = 'STACKBITE_NPM_REGISTRATION_REMAINS';
  remains.nativeCompleted = true;
  remains.registrationPrefix = prefix;
  remains.removalCommand = ['npm', 'uninstall', '--global', '--prefix', prefix, 'stackbite'];
  remains.checked = unavailable.checked;
  return remains;
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
  if (!await ancestorsAreDirectories(file)) throw new Error('Linked npm command preserved');
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
  let cli = options.npmCli;
  if (!cli) {
    try { cli = await npmProgram(root, node, { ...options, prefix }); }
    catch (error) {
      // The caller may omit the descriptor and name this registration as residue.
      if (error.code === 'STACKBITE_NPM_CLI_UNAVAILABLE') Object.assign(error, { registrationRoot: root, registrationPrefix: prefix });
      throw error;
    }
  }
  return { root, prefix, node: await fs.realpath(node), cli: await fs.realpath(cli) };
}

// A descriptor, or null with the reason when no verified npm CLI exists. The
// native product still runs without STACKBITE_NPM_REGISTRATION; the npm
// package is then never removed by it. Every other refusal stays an error.
async function optionalDescriptor(options = {}) {
  try { return { npm: await descriptor(options), unavailable: null }; }
  catch (error) { if (error.code !== 'STACKBITE_NPM_CLI_UNAVAILABLE') throw error; return { npm: null, unavailable: error }; }
}

// After a native removal that ran without a descriptor: only a finished native
// removal (exit 0) whose npm registration still physically exists is reported
// as completed native removal plus registration residue with its next action.
// Exit 2 is the native engine's pending answer, never completion: it stands as
// is, like a refusal or a signal, and claims nothing about npm.
async function settleWithoutNpm(argv, result, unavailable, platform = process.platform) {
  if (!unavailable || !acceptedRemoval(argv, result) || result.code !== 0) return result;
  try { await fs.lstat(unavailable.registrationRoot); }
  catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  throw registrationRemains(unavailable.registrationPrefix, unavailable, platform);
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
  // The engine wrote the journal, its installation identity and its capsule
  // pins under the real path of this root. A root reached through the user's
  // own link (a linked HOME or XDG directory) is read there, so those recorded
  // paths are compared with the files that are actually opened and run. A
  // link the engine would not follow stays as given and is refused below.
  const root = await realRoot(options.installRoot || path.join(productData(environment, platform).data, platform === 'win32' ? 'Stackbite' : 'stackbite'));
  const journal = path.join(root, '.stackbite-uninstall.json');
  const record = await readRemovalJournal(journal);
  if (record === undefined) return null;
  if (record.schema !== 'stackbite.uninstall.v1' || !record.accepted || !processesDone(record)
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

async function realRoot(root) {
  try { return (await followLayoutLink(root)).resolved; }
  catch (error) { if (error.code !== 'STACKBITE_LINK_REFUSED') throw error; return root; }
}

// Uninstall recovery also runs this file by itself after npm has removed its siblings.
// Windows PowerShell reads the owner of each junction itself and the directory holding it.
// The token user and system SIDs match private-files/src/layout_link.rs.
const OTHER_OWNER = 'the link is owned by another user';
const SHARED_HOLDER = 'the directory holding the link can be rewritten by another user';
const SYSTEM = 'S-1-5-18', ADMINISTRATORS = 'S-1-5-32-544';
const TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const PATHS = 'STACKBITE_LAYOUT_LINK_PATHS';
const SID = /^S-1-\d+(?:-\d+)+$/;

// One line for the token user, then one per path; '-' where the read failed.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$sid = [System.Security.Principal.SecurityIdentifier]',
  'try { [Console]::Out.WriteLine([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) }',
  "catch { [Console]::Out.WriteLine('-') }",
  `foreach ($p in $env:${PATHS}.Split('|')) {`,
  "  try { [Console]::Out.WriteLine((New-Object System.Security.AccessControl.DirectorySecurity($p, 'Owner')).GetOwner($sid).Value) }",
  "  catch { [Console]::Out.WriteLine('-') }",
  '}',
].join('\n');

function variable(environment, name) {
  const key = Object.keys(environment).find(key => key.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

// { user, owners }: the SID of this process's user and of each path's owner,
// null where it could not be read. Rejects when nothing could be read at all.
function readWindowsOwners(paths, { environment = process.env, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    // '|' cannot be part of a Windows file name; it separates the operands.
    if (!paths.every(item => typeof item === 'string' && path.win32.isAbsolute(item) && !/[|\0\r\n]/.test(item))) {
      throw new Error('owner read needs absolute Windows paths');
    }
    const system = variable(environment, 'SystemRoot') || variable(environment, 'windir');
    if (!system || !path.win32.isAbsolute(system)) throw new Error('SystemRoot is not set');
    const child = { [PATHS]: paths.join('|') };
    // A PSModulePath of another PowerShell edition breaks this one's start-up.
    for (const [name, value] of Object.entries(environment)) {
      if (![PATHS.toLowerCase(), 'psmodulepath'].includes(name.toLowerCase())) child[name] = value;
    }
    const shell = path.win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')];
    require('node:child_process').execFile(shell, args, { env: child, timeout, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new Error(error.killed ? 'owner read timed out' : 'owner read failed'));
      const lines = stdout.trim().split(/\r?\n/).map(line => SID.test(line) ? line : null);
      if (lines.length !== paths.length + 1) return reject(new Error('owner read failed'));
      resolve({ user: lines[0], owners: lines.slice(1) });
    });
  });
}

// Judge one link and the directory that holds it. Never rejects: the answer is
// { owner, holderOwner, reason, detail }, where a null reason means the link
// may be followed and anything else is the engine's refusal reason. owner is
// the link's own owner SID (null when unknown), for the refusal message.
async function judgeWindowsLink(link, holder, options = {}) {
  let read;
  try { read = await (options.read || readWindowsOwners)([link, holder], options); }
  catch (error) { return { owner: null, holderOwner: null, reason: OTHER_OWNER, detail: error.message }; }
  const { user, owners: [owner, holderOwner] } = read;
  const trusted = sid => sid === SYSTEM || sid === ADMINISTRATORS || sid === TRUSTED_INSTALLER || (user !== null && sid === user);
  const answer = (reason, detail) => ({ owner, holderOwner, reason, detail });
  if (owner === null) return answer(OTHER_OWNER, 'the owner of the link could not be read');
  if (!trusted(owner)) return answer(OTHER_OWNER, `the link is owned by ${owner}, not by ${user ?? 'this user (unknown)'} or the system`);
  if (holderOwner === null) return answer(SHARED_HOLDER, 'the owner of the directory holding the link could not be read');
  if (!trusted(holderOwner)) return answer(SHARED_HOLDER, `the directory holding the link is owned by ${holderOwner}, not by ${user ?? 'this user (unknown)'} or the system`);
  return answer(null, null);
}

function linkRefused(link, target, owner, reason) {
  const error = new Error(`Not following link ${link} -> ${target ?? '(target unreadable)'} (owner ${owner ?? 'unknown'}): ${reason}`);
  return Object.assign(error, { code: 'STACKBITE_LINK_REFUSED', link, target, owner, reason });
}

const pathParts = text => text.split(path.sep).filter(part => part && part !== '.');

// { resolved, links }: `given` with every link on it followed; links counts them.
async function followLayoutLink(given) {
  given = path.resolve(given);
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  const trusted = owner => owner === 0 || owner === uid;
  let current = path.parse(given).root, links = 0;
  const pending = pathParts(given.slice(current.length));
  while (pending.length) {
    const name = pending.shift();
    // Only a link target can supply this; the prefix is link-free.
    if (name === '..') { current = path.dirname(current); continue; }
    const candidate = path.join(current, name);
    let info;
    try { info = await fs.lstat(candidate); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { resolved: path.join(candidate, ...pending), links };
    }
    if (!info.isSymbolicLink()) { current = candidate; continue; }
    let target = null;
    try { target = await fs.readlink(candidate); } catch { /* refused below */ }
    let owner = info.uid;
    if (uid === null) {
      const verdict = await judgeWindowsLink(candidate, current);
      owner = verdict.owner;
      if (verdict.reason) throw linkRefused(candidate, target, owner, verdict.reason);
    } else {
      if (!trusted(owner)) throw linkRefused(candidate, target, owner, OTHER_OWNER);
      const holder = await fs.stat(current);
      if (!trusted(holder.uid) || ((holder.mode & 0o022) !== 0 && (holder.mode & 0o1000) === 0)) {
        throw linkRefused(candidate, target, owner, SHARED_HOLDER);
      }
    }
    if (target === null) throw linkRefused(candidate, null, owner, 'the link target cannot be read');
    if (links === 40) throw linkRefused(candidate, target, owner, 'more than 40 links on the path');
    links += 1;
    if (path.isAbsolute(target)) {
      current = path.parse(target).root;
      pending.unshift(...pathParts(target.slice(current.length)));
    } else pending.unshift(...pathParts(target));
  }
  return { resolved: current, links };
}

// The one finalize-eligibility contract (the Rust controller's
// `uninstall_controller::processes_done`, the POSIX cleanup capsule and the
// npm bootstrap read the same): every selected state settled, or
// `processes_released` over a validated R4 waiver record. A waiver never sets
// `processes_settled`. Structure only; the hash is not recomputed.
function processesDone(record) {
  return record.processes_settled === true
    || (record.processes_released === true && waivedDebt(record.waived_recovery_members));
}

function waivedDebt(waived) {
  if (!waived || typeof waived !== 'object' || Array.isArray(waived)) return false;
  let entries = 0;
  for (const list of Object.values(waived)) {
    if (!Array.isArray(list) || !list.every(waiverEntry)) return false;
    entries += list.length;
  }
  return entries > 0;
}

function waiverEntry(entry) {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry)
    && entry.bytes !== undefined && entry.bytes !== null
    && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)
    && Array.isArray(entry.waived) && entry.waived.length > 0
    && entry.waived.every(name => typeof name === 'string')
    && !!entry.report && typeof entry.report === 'object' && !Array.isArray(entry.report)
    && entry.signalled === false;
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

module.exports = { registration, npmProgram, removeRegistration, explicitApply, descriptor, optionalDescriptor, settleWithoutNpm,
  resumeWithoutRuntime, registrationOnly, ownCommandLink, processesDone, followLayoutLink, judgeWindowsLink, readWindowsOwners, OTHER_OWNER, SHARED_HOLDER };
