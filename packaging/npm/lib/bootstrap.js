'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { LIMITS, fail, memberPath, inside, hashFile, readSmall, exists } = require('./common');
const { download } = require('./download');
const { extractArchive } = require('./archive');
const { cacheDirectory, existingCacheDirectory, resolveCacheDirectory } = require('./cache');
const { parseSetup, stageReporter } = require('./setup');
const timing = require('./startup-timing');
const packageVersion = require('../../../package.json').version;

// Only a glibc Linux host (or an injected runtime report) may select the Linux release.
function checkLinuxRuntime(platform, runtime) {
  if (platform === 'linux' && (process.platform === 'linux' || Object.hasOwn(runtime, 'glibcVersionRuntime'))) {
    const glibc = Object.hasOwn(runtime, 'glibcVersionRuntime')
      ? runtime.glibcVersionRuntime : process.report.getReport().header.glibcVersionRuntime;
    if (typeof glibc !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(glibc)) {
      fail('Stackbite requires Linux x64 with glibc; Alpine/musl Linux is unsupported. No release was downloaded.');
    }
  }
}
function checkReleaseIdentity(manifest) {
  if (manifest.schema !== 1 || manifest.version !== packageVersion || !/^[a-f0-9]{40}$/.test(manifest.commit)
      || manifest.repository !== 'Shinick-Han/stackbite') fail('Invalid pinned Stackbite release identity');
}
// The platform entry must name exactly the derived root, asset and GitHub release URL.
function checkPinnedAsset(spec, manifest, root, asset) {
  if (!spec || spec.root !== root || spec.asset !== asset
      || spec.url !== `https://github.com/${manifest.repository}/releases/download/v${manifest.version}/${asset}`
      || ![spec.sha256, spec.manifestSha256, spec.metadataSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
      || !Number.isSafeInteger(spec.size) || spec.size <= 0 || spec.size > LIMITS.download) fail('Invalid pinned release asset');
}
function releaseSpec(manifest, platform = process.platform, arch = process.arch, runtime = {}) {
  const key = `${platform}-${arch}`;
  if (!['win32-x64', 'linux-x64', 'darwin-arm64'].includes(key)) fail(`Stackbite does not have a native release for ${key}; supported platforms are Windows x64, Linux x64 and macOS arm64.`);
  checkLinuxRuntime(platform, runtime);
  checkReleaseIdentity(manifest);
  const spec = manifest.platforms?.[key];
  const host = { win32: 'windows-x64', linux: 'linux-x86_64', darwin: 'macos-arm64' }[platform];
  const root = `stackbite-${manifest.version}-${host}-${manifest.commit.slice(0, 12)}`;
  const asset = root + (platform === 'win32' ? '.zip' : '.tar.gz');
  checkPinnedAsset(spec, manifest, root, asset);
  return { ...spec, key, platform, host, version: manifest.version, commit: manifest.commit };
}
async function payloadRoot(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Cached release root is not a regular directory');
  return fs.realpath(directory);
}
// Both pinned documents are read before either digest is compared, then parsed in the same order.
async function pinnedDocuments(root, spec) {
  const manifestPath = path.join(root, 'SHA256SUMS.json'), metadataPath = path.join(root, 'portable.json');
  const manifestBytes = await readSmall(manifestPath), metadataBytes = await readSmall(metadataPath, 16384);
  if (createHash('sha256').update(manifestBytes).digest('hex') !== spec.manifestSha256
      || createHash('sha256').update(metadataBytes).digest('hex') !== spec.metadataSha256) fail('Pinned release manifest or metadata SHA-256 mismatch');
  const hashes = JSON.parse(manifestBytes.toString('utf8'));
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  return { hashes, metadata };
}
function expectedMembers(hashes) {
  if (!hashes || Array.isArray(hashes) || typeof hashes !== 'object' || !Object.keys(hashes).length
      || Object.keys(hashes).length > LIMITS.members) fail('Invalid release file manifest');
  const expected = new Set();
  for (const [name, digest] of Object.entries(hashes)) {
    if (memberPath(name) !== name || !/^[a-f0-9]{64}$/.test(digest) || ['SHA256SUMS.json', 'SHA256SUMS'].includes(name)) fail('Invalid release manifest member');
    expected.add(name);
  }
  if (!expected.has('portable.json') || !expected.has('runtime/build-info.json')) fail('Required release metadata is missing');
  return expected;
}
// Runs at most `limit` tasks at once; queued tasks start in submission order.
function boundedRunner(limit) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= limit || !queue.length) return;
    const { task, resolve, reject } = queue.shift();
    active++;
    task().then(resolve, reject).finally(() => { active--; next(); });
  }
  return task => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
}
// Bounded concurrency overlaps selected file reads; every selected member is hashed in full.
const HASH_CONCURRENCY = 8;
// Walks the payload; every file or in-root link must resolve to a bounded regular file and pinned members must match.
async function payloadFiles(root, expected, hashes, includePhone) {
  const actual = new Set(), run = boundedRunner(HASH_CONCURRENCY), checks = [];
  let total = 0, entries = 0;
  async function checkHash(relative, resolved) {
    if (await hashFile(resolved) !== hashes[relative]) fail(`Release file SHA-256 mismatch: ${relative}`);
  }
  async function visit(directoryPath) {
    for (const name of await fs.readdir(directoryPath)) {
      // Optional Phone is checked at activation. Do not traverse an unused tree,
      // including a missing or redirected tree; selected runtime links cannot use it.
      if (!includePhone && directoryPath === root && name === 'phone') continue;
      if (++entries > LIMITS.members * 2) fail('Cached release has too many entries');
      const target = path.join(directoryPath, name), relative = path.relative(root, target).split(path.sep).join('/');
      memberPath(relative);
      const entry = await fs.lstat(target);
      if (entry.isDirectory()) { await visit(target); continue; }
      if (!entry.isFile() && !entry.isSymbolicLink()) fail('Release contains a special file');
      const resolved = await fs.realpath(target);
      if (!inside(root, resolved)) fail('Release link escapes the cache root');
      if (!includePhone && path.relative(root, resolved).split(path.sep)[0] === 'phone') fail('Runtime link resolves into optional Phone payload');
      const resolvedInfo = await fs.lstat(resolved);
      if (!resolvedInfo.isFile() || resolvedInfo.size > LIMITS.member) fail('Release link does not resolve to a bounded regular file');
      total += resolvedInfo.size;
      if (total > LIMITS.expanded) fail('Cached release exceeds expansion limit');
      actual.add(relative);
      // Each check settles to its error (or null) at once, so none is ever an unhandled rejection.
      if (expected.has(relative)) checks.push(run(() => checkHash(relative, resolved)).then(() => null, error => error));
    }
  }
  // Every started read settles before returning or failing; a walk failure takes precedence,
  // otherwise the first mismatch in walk order is reported.
  const walkError = await visit(root).then(() => null, error => error);
  const hashErrors = await Promise.all(checks);
  if (walkError) throw walkError;
  const mismatch = hashErrors.find(Boolean);
  if (mismatch) throw mismatch;
  return actual;
}
// The checksum documents themselves are the only unhashed members; Linux also ships the text form.
async function checkMemberSet(root, spec, hashes, expected, actual) {
  expected.add('SHA256SUMS.json');
  if (spec.platform !== 'win32') {
    expected.add('SHA256SUMS');
    const text = await readSmall(path.join(root, 'SHA256SUMS'));
    if (text.toString('utf8') !== Object.entries(hashes).map(([name, digest]) => `${digest}  ${name}\n`).join('')) fail(`${spec.platform === 'linux' ? 'Linux' : 'macOS'} checksum text disagrees with pinned manifest`);
  }
  if (actual.size !== expected.size || [...actual].some(name => !expected.has(name))) fail('Release files disagree with pinned manifest');
}
async function checkProductIdentity(root, spec, metadata) {
  const build = JSON.parse((await readSmall(path.join(root, 'runtime', 'build-info.json'), 16384)).toString('utf8'));
  for (const value of [metadata, build]) {
    if (value.version !== spec.version || value.commit !== spec.commit || value.product !== 'Stackbite'
        || (value.command !== undefined && value.command !== 'stackbite')
        || ((spec.platform === 'darwin' || value.platform !== undefined) && value.platform !== spec.host)) fail('Release product/version/commit identity mismatch');
  }
}
async function nativeExecutable(root, spec, name = 'stackbite') {
  const executable = path.join(root, name + (spec.platform === 'win32' ? '.exe' : ''));
  const image = await fs.lstat(executable);
  if (!image.isFile() || image.isSymbolicLink()) fail('Native release executable is missing or a link');
  const file = await fs.open(executable, 'r');
  try {
    const header = Buffer.alloc(spec.platform === 'darwin' ? 16 : 4);
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length) fail('Invalid native executable identity');
    const valid = spec.platform === 'win32' ? header.subarray(0, 2).equals(Buffer.from('MZ'))
      : spec.platform === 'darwin' ? header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x0100000c && header.readUInt32LE(12) === 2
      : header.equals(Buffer.from([0x7f, 69, 76, 70]));
    if (!valid) fail('Invalid native executable identity');
  } finally { await file.close(); }
  if (spec.platform !== 'win32' && process.platform !== 'win32' && !(image.mode & 0o111)) fail('Native release executable has no execute permission');
  return executable;
}
// The release pins the whole payload before this mapping. Windows opens the
// frozen engine, which selects the Rust TUI/owner; POSIX opens the native entry.
// A bundled native entry is validated on every platform before either choice.
async function publicExecutable(root, spec, hashes) {
  const engine = await nativeExecutable(root, spec);
  const name = 'stackbite-launcher' + (spec.platform === 'win32' ? '.exe' : '');
  if (!Object.hasOwn(hashes, name)) {
    if (await exists(path.join(root, name))) fail('Native entry is present without a release pin');
    return engine;
  }
  const manifest = JSON.parse((await readSmall(path.join(root, 'manifest.json'))).toString('utf8'));
  const entry = manifest.binaries?.['stackbite-launcher'], info = entry?.build_info;
  const target = { win32: 'x86_64-pc-windows-msvc', linux: 'x86_64-unknown-linux-gnu', darwin: 'aarch64-apple-darwin' }[spec.platform];
  if (!terminalBuildMatches(manifest, spec, target) || !launcherPinMatches(manifest, entry, name, hashes)
      || !launcherBuildInfoMatches(info, spec, target)) fail('Native entry package identity or pin is invalid');
  const launcher = await nativeExecutable(root, spec, 'stackbite-launcher');
  return spec.platform === 'win32' ? engine : launcher;
}
function terminalBuildMatches(manifest, spec, target) {
  return manifest.schema === 'stackbite-rust-terminal-build-v1' && manifest.product === 'Stackbite'
    && manifest.version === spec.version && manifest.commit === spec.commit && manifest.target === target && manifest.protocol === 1;
}
// The manifest entry and its artifact record both pin the release hash of `name`.
function launcherPinMatches(manifest, entry, name, hashes) {
  return !!entry && Object.keys(entry).sort().join(',') === 'build_info,path,sha256'
    && entry.path === name && entry.sha256 === hashes[name] && manifest.artifacts?.[name]?.sha256 === hashes[name]
    && manifest.artifacts?.[name]?.kind === 'binary' && Number.isSafeInteger(manifest.artifacts?.[name]?.size) && !(manifest.artifacts[name].size < 1);
}
function launcherBuildInfoMatches(info, spec, target) {
  return !!info && Object.keys(info).sort().join(',') === 'binary,commit,product,protocol,target,version'
    && info.product === 'Stackbite' && info.binary === 'stackbite-launcher' && info.version === spec.version
    && info.commit === spec.commit && info.target === target && info.protocol === 1;
}
async function validatePayload(directory, spec, { includePhone = true } = {}) {
  const root = await payloadRoot(directory);
  const { hashes, metadata } = await pinnedDocuments(root, spec);
  const expected = expectedMembers(hashes);
  if (!includePhone) for (const name of expected) if (name.startsWith('phone/')) expected.delete(name);
  const actual = await payloadFiles(root, expected, hashes, includePhone);
  await checkMemberSet(root, spec, hashes, expected, actual);
  await checkProductIdentity(root, spec, metadata);
  return publicExecutable(root, spec, hashes);
}

function installationRoot(environment, platform) {
  const home = environment.USERPROFILE || environment.HOME || os.homedir();
  // Python's locator/control root is distinct from npm's cache root.
  return platform === 'win32'
    ? path.resolve(environment.LOCALAPPDATA || home, 'Stackbite')
    : path.resolve(environment.XDG_DATA_HOME || path.join(environment.HOME || home, '.local', 'share'), 'stackbite');
}
// Resolve only user-selected directory roots. Managed descendants, including
// the installation root and update directory, must still be real directories.
async function selectedDirectory(directory, environment, platform) {
  const home = environment.USERPROFILE || environment.HOME || os.homedir();
  const data = platform === 'win32' ? environment.LOCALAPPDATA || home
    : environment.XDG_DATA_HOME || path.join(environment.HOME || home, '.local', 'share');
  const roots = [data, home].map(root => path.resolve(root)).sort((a, b) => b.length - a.length);
  const selected = roots.find(root => directory === root || inside(root, directory));
  if (!selected) return existingCacheDirectory(directory);
  const resolved = await resolveCacheDirectory(selected);
  return existingCacheDirectory(path.join(resolved, path.relative(selected, directory)));
}
// Before a runtime is available, read the SAME journal without creating any
// product directory. The verified bundled engine repeats this under OS locks
// and owns cache/locator publication. This read is not a JavaScript flock.
async function admitPublication(environment, platform) {
  const root = installationRoot(environment, platform);
  if (!await selectedDirectory(root, environment, platform)) return;
  const journal = path.join(root, '.stackbite-uninstall.json');
  if (!await exists(journal)) return;
  const record = JSON.parse((await readSmall(journal, 8 * 1024 * 1024)).toString('utf8').replace(/^\uFEFF/, ''));
  if (record.schema !== 'stackbite.uninstall.v1' || !['prepared', 'stopped', 'deferred', 'complete'].includes(record.phase)) {
    fail('Stackbite removal is in progress');
  }
  const current = await locatorIncarnation(root);
  const saved = record.install_identity;
  if (saved != null && (saved.root !== root || !/^[a-f0-9]{32}$/.test(saved.incarnation))) fail('Invalid removal installation identity');
  if (current && (!saved || current !== saved.incarnation)) return;
  fail('Stackbite removal is in progress');
}
async function locatorIncarnation(root) {
  for (const name of ['default-install.json', 'install.json']) {
    const locator = path.join(root, name);
    if (!await exists(locator)) continue;
    const value = JSON.parse((await readSmall(locator, 16384)).toString('utf8').replace(/^\uFEFF/, ''));
    if (!value || Array.isArray(value) || typeof value !== 'object'
        || (value.installation_id != null && !/^[a-f0-9]{32}$/.test(value.installation_id))) fail('Invalid Stackbite installation locator');
    return value.installation_id ?? null;
  }
  return null;
}
// An accepted removal of the CURRENT installation that stopped before its
// capsule existed (no recovery_command). Only a release-pinned runtime from this
// package can continue it. The digest binds the same request bytes until launch.
async function acceptedRemovalWithoutCapsule(environment, platform) {
  const root = installationRoot(environment, platform);
  if (!await selectedDirectory(root, environment, platform)) return null;
  const journal = path.join(root, '.stackbite-uninstall.json');
  let info;
  try { info = await fs.lstat(journal); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('Unsafe removal journal');
  const bytes = await readSmall(journal, 8 * 1024 * 1024);
  const record = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const saved = record?.install_identity;
  if (record?.schema !== 'stackbite.uninstall.v1' || record.phase !== 'prepared' || record.accepted !== true
      || record.removal_requested !== true || record.recovery_command != null
      || typeof record.request_id !== 'string' || !record.request_id
      || saved?.root !== root || !/^[a-f0-9]{32}$/.test(saved.incarnation)) return null;
  // A reinstall after this request (another incarnation) is not this removal's target.
  const current = await locatorIncarnation(root);
  if (current !== null && current !== saved.incarnation) return null;
  return { journal, request: record.request_id, incarnation: saved.incarnation,
    digest: createHash('sha256').update(bytes).digest('hex') };
}

async function baselinePin(file, environment, platform) {
  if (environment) await selectedDirectory(path.dirname(file), environment, platform);
  else await existingCacheDirectory(path.dirname(file));
  let info;
  try { info = await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    const kind = info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'regular' : info.isDirectory() ? 'directory' : 'other';
    fail(`Invalid installation baseline file: ${JSON.stringify(file)} (kind=${kind}, nlink=${info.nlink})`);
  }
  return { device: info.dev.toString(), inode: info.ino.toString() };
}
async function captureBaseline(environment, platform, cachedHome, packageRoot) {
  const root = installationRoot(environment, platform);
  for (const name of ['default-install.json', 'install.json']) {
    const file = path.join(root, name);
    if (!await exists(file)) continue;
    const value = JSON.parse((await readSmall(file, 16384)).toString('utf8').replace(/^\uFEFF/, ''));
    if (value.installation_id != null) {
      if (!/^[a-f0-9]{32}$/.test(value.installation_id)) fail('Invalid installation incarnation');
      return { root, incarnation: value.installation_id };
    }
    break;
  }
  const old = path.join(path.dirname(root), platform === 'win32' ? 'Helm' : 'helm');
  const paths = [root, old].flatMap(base => ['default-install.json', 'install.json'].map(name => path.join(base, name)));
  const home = platform === 'win32' ? environment.USERPROFILE || os.homedir() : environment.HOME || os.homedir();
  paths.push(...(platform === 'win32' ? ['stackbite.cmd', 'stackbite-portable.cmd', 'stackbite.exe'] : ['stackbite'])
    .map(name => path.join(home, '.local', 'bin', name)));
  const homes = new Set([cachedHome]);
  for (const file of paths.slice(0, 4)) {
    if (!await exists(file)) continue;
    const value = JSON.parse((await readSmall(file, 16384)).toString('utf8').replace(/^\uFEFF/, ''));
    if (typeof value.home === 'string' && path.isAbsolute(value.home)) homes.add(value.home);
  }
  for (const selected of homes) {
    for (const name of ['portable.json', platform === 'win32' ? 'stackbite.exe' : 'stackbite', 'stackbite.py']) {
      const file = path.join(selected, name);
      if (await baselinePin(file, environment, platform) !== null) paths.push(file);
    }
  }
  const legacy = [];
  for (const file of new Set(paths)) {
    if (packageRoot && platform !== 'win32' && file === path.join(home, '.local', 'bin', 'stackbite')
        && await exists(file) && await require('./uninstall-registration').ownCommandLink(file, packageRoot, platform)) continue;
    legacy.push({ path: file, identity: await baselinePin(file, environment, platform) });
  }
  return legacy.some(pin => pin.identity !== null) ? { root, incarnation: null, legacy } : null;
}

async function assertBaseline(environment, platform) {
  const raw = environment.STACKBITE_INSTALL_BASELINE;
  if (raw === undefined) return;
  if (Buffer.byteLength(raw) > 16384) fail('Invalid installation baseline');
  const expected = JSON.parse(raw), root = installationRoot(environment, platform);
  if (expected.preparation !== undefined) {
    await assertPreparationBaseline(expected, root, platform, environment);
    return;
  }
  const current = await locatorInstallationId(root);
  if (expected.root !== root || expected.incarnation !== current) fail('Installation changed while staging');
  if (current === null) await assertLegacyBaseline(expected, platform, environment);
}
// Python-origin restrictions retain FILE_ID_INFO's full volume serial;
// libuv reports its 32-bit component. The engine still checks the full pin.
function libuvIdentity(platform, actual, identity) {
  return platform === 'win32' && actual && identity ? { ...identity, device: (BigInt(identity.device) & 0xffffffffn).toString() } : identity;
}
async function assertPreparationBaseline(expected, root, platform, environment) {
  const pin = expected.preparation, file = path.join(root, '.stackbite-update', 'update.lock');
  if (Object.keys(expected).sort().join(',') !== 'preparation,root' || expected.root !== root
      || !pin || Object.keys(pin).sort().join(',') !== 'identity,path' || pin.path !== file || !pin.identity) fail('Invalid installation preparation');
  const actual = await baselinePin(file, environment, platform);
  if (JSON.stringify(actual) !== JSON.stringify(libuvIdentity(platform, actual, pin.identity))) fail('Installation changed while staging');
}
// The first present locator's incarnation; null for a legacy or absent locator.
async function locatorInstallationId(root) {
  for (const name of ['default-install.json', 'install.json']) {
    const file = path.join(root, name);
    if (!await exists(file)) continue;
    const value = JSON.parse((await readSmall(file, 16384)).toString('utf8').replace(/^\uFEFF/, ''));
    return value.installation_id ?? null;
  }
  return null;
}
async function assertLegacyBaseline(expected, platform, environment) {
  if (!Array.isArray(expected.legacy) || !expected.legacy.length || expected.legacy.length > 32) fail('Invalid legacy installation baseline');
  for (const pin of expected.legacy) {
    const actual = await baselinePin(pin.path, environment, platform);
    if (JSON.stringify(actual) !== JSON.stringify(libuvIdentity(platform, actual, pin.identity))) fail('Installation changed while staging');
  }
}

async function pinRegistration(npm, options) {
  if (!npm) return null;
  const file = path.join(npm.root, 'package.json');
  const handle = await fs.open(file, require('node:fs').constants.O_RDONLY | (require('node:fs').constants.O_NOFOLLOW || 0));
  try {
    const held = await handle.stat({ bigint: true }), root = await fs.lstat(npm.root, { bigint: true });
    const identity = { device: held.dev.toString(), inode: held.ino.toString() };
    const source = {
      packageRoot: npm.root,
      async validate() {
        const current = await fs.lstat(npm.root, { bigint: true });
        const descriptor = await require('./uninstall-registration').descriptor(options);
        if (!held.isFile() || held.nlink !== 1n || !current.isDirectory() || current.isSymbolicLink()
            || current.dev !== root.dev || current.ino !== root.ino
            || JSON.stringify(await baselinePin(file)) !== JSON.stringify(identity)
            || JSON.stringify(descriptor) !== JSON.stringify(npm)) fail('npm registration changed while staging');
      },
      async absent() {
        try { await fs.lstat(npm.root); return false; }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
      },
      close: () => handle.close()
    };
    await source.validate();
    return source;
  } catch (error) { await handle.close(); throw error; }
}

async function settlePreparation(preparation, environment, platform, source) {
  try {
    // Only the failed publisher's newly created object is ours. A replacement
    // registration, locator, payload, control inode or foreign file survives.
    if (!preparation.created || !source || !await source.absent()
        || await captureBaseline(environment, platform, preparation.target)) return;
    for (const [directory, pin] of preparation.directories) {
      await selectedDirectory(directory, environment, platform);
      const current = await fs.lstat(directory, { bigint: true });
      if (current.dev !== pin.dev || current.ino !== pin.ino) return;
    }
    const { file, identity, handle } = preparation;
    if (JSON.stringify(await baselinePin(file, environment, platform)) !== JSON.stringify(identity)) return;
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.nlink !== 1n || held.size > 1n) return;
    const bytes = Buffer.alloc(2);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    // Windows' existing Python byte-range gate initializes this SAME inode.
    if (BigInt(bytesRead) !== held.size || bytesRead === 1 && bytes[0] !== 0x30) return;
    await fs.unlink(file);
    for (const [directory, pin] of preparation.directories) {
      await selectedDirectory(directory, environment, platform);
      const current = await fs.lstat(directory, { bigint: true });
      if (current.dev !== pin.dev || current.ino !== pin.ino) break;
      await fs.rmdir(directory);
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  } finally { await preparation.handle.close(); }
}

// Identities of the candidates that this mkdir created (the first created directory and below).
async function createdDirectories(firstCreated, candidates) {
  const directories = [];
  if (firstCreated) {
    for (const selected of candidates) {
      // libuv may return a Windows namespace spelling for the first directory.
      const createdName = path.toNamespacedPath(firstCreated), selectedName = path.toNamespacedPath(selected);
      if (selectedName === createdName || selectedName.startsWith(createdName + path.sep)) {
        directories.push([selected, await fs.lstat(selected, { bigint: true })]);
      }
    }
  }
  return directories;
}
// Creates the control file, or opens the existing one; `created` marks ours.
async function openPreparationFile(file) {
  const constants = require('node:fs').constants;
  try {
    return { handle: await fs.open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600), created: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { handle: await fs.open(file, constants.O_RDWR | (constants.O_NOFOLLOW || 0)), created: false };
  }
}
async function reservePreparation(environment, platform, target, source) {
  if (Object.hasOwn(environment, 'STACKBITE_INSTALL_BASELINE')) return null;
  let baseline = await captureBaseline(environment, platform, target, source?.packageRoot);
  if (baseline) {
    environment.STACKBITE_INSTALL_BASELINE = JSON.stringify(baseline);
    return null;
  }
  // First use has no locator to pin. Hold the existing installation control
  // file open across staging, with libuv's Windows delete sharing. This reserves
  // object identity only; the bundled engine still takes the kernel gates.
  const root = installationRoot(environment, platform), directory = path.join(root, '.stackbite-update');
  await admitPublication(environment, platform);
  await selectedDirectory(directory, environment, platform);
  for (let parent = root; ; parent = path.dirname(parent)) {
    if (await exists(path.join(parent, '.git'))) fail('Refusing installation preparation in a source repository');
    if (parent === path.dirname(parent)) break;
  }
  if (source) await source.validate();
  const firstCreated = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await selectedDirectory(directory, environment, platform);
  const directories = await createdDirectories(firstCreated, [directory, root]);
  const file = path.join(directory, 'update.lock');
  const { handle, created } = await openPreparationFile(file);
  let preparation;
  try {
    const held = await handle.stat({ bigint: true });
    const identity = await baselinePin(file, environment, platform);
    if (!held.isFile() || held.nlink !== 1n || JSON.stringify(identity) !== JSON.stringify({ device: held.dev.toString(), inode: held.ino.toString() })) fail('Invalid installation preparation');
    preparation = { handle, file, identity, created, directories, target };
    baseline = { root, preparation: { path: file, identity } };
    environment.STACKBITE_INSTALL_BASELINE = JSON.stringify(baseline);
    if (source) await source.validate();
    await admitPublication(environment, platform);
    await assertBaseline(environment, platform);
    return preparation;
  } catch (error) {
    if (preparation) await settlePreparation(preparation, environment, platform, source);
    else await handle.close();
    throw error;
  }
}

// Durable runtime images share the standalone installer's versioned app root,
// with its live-reference retention and removal inventory. The disposable
// cache only holds images of the previous layout, which may be adopted.
// A different archive of the same version and commit (for example a signed
// rebuild) gets a sibling qualified by its pinned archive digest, so an image
// another installer or pin published is never replaced or run under this pin.
function runtimeName(spec, qualified = false) {
  const commit = spec.commit.slice(0, 12), version = spec.version + (qualified ? `-pin${spec.sha256.slice(0, 10)}` : '');
  return spec.platform === 'win32' ? `${version}-${commit}` : `stackbite-${version}-${spec.host}-${commit}`;
}
async function pinnedTarget(runtime, spec) {
  const canonical = path.join(runtime, runtimeName(spec));
  if (!await exists(canonical)) return canonical;
  try { await pinnedDocuments(await payloadRoot(canonical), spec); return canonical; }
  catch (error) { if (/manifest or metadata SHA-256 mismatch/.test(error.message)) return path.join(runtime, runtimeName(spec, true)); throw error; }
}
function previousCacheHome(home, cache, platform) {
  const spelling = value => platform === 'win32' ? value.toLowerCase() : value;
  return typeof home === 'string' && path.isAbsolute(home) && /^v1-[a-f0-9]{64}$/.test(path.basename(home))
    && !!cache && spelling(path.dirname(path.resolve(home))) === spelling(cache);
}
// Bounded portable.json of an image; null when absent, linked, oversized or malformed.
async function portableMetadata(root) {
  try { return JSON.parse((await readSmall(path.join(root, 'portable.json'), 16384)).toString('utf8')); }
  catch { return null; }
}
// The release identity Python's former-cache check compares (Windows may omit platform).
function portableMatches(value, spec) {
  return !!value && typeof value === 'object' && value.product === 'Stackbite' && value.command === 'stackbite'
    && value.version === spec.version && value.commit === spec.commit
    && (Object.hasOwn(value, 'platform') ? value.platform : spec.platform === 'win32' ? spec.host : undefined) === spec.host;
}
// An absolute literal path with no linked ancestor and no source repository.
async function literalPath(home) {
  if (!path.isAbsolute(home) || path.resolve(home) !== home) return false;
  for (let ancestor = home; ; ancestor = path.dirname(ancestor)) {
    let info = null;
    try { info = await fs.lstat(ancestor); } catch (error) { if (error.code !== 'ENOENT') return false; }
    if (info?.isSymbolicLink() || info && await exists(path.join(ancestor, '.git'))) return false;
    if (ancestor === path.dirname(ancestor)) return true;
  }
}
// A previous-layout cache image recorded by a host with another cache root:
// the shape and portable identity Python's _former_cache_image accepts. This
// classifies the file only; no environment state changes it. It is only read.
async function formerCache(home, spec) {
  if (typeof home !== 'string' || !/^v1-[a-f0-9]{64}$/.test(path.basename(home))
      || path.basename(path.dirname(home)) !== 'stackbite') return null;
  try {
    if (!await literalPath(home) || !(await fs.lstat(home)).isDirectory()) return null;
  } catch { return null; }
  return portableMatches(await portableMetadata(home), spec) ? home : null;
}
// A former cache selection this run may migrate: the engine moves a selection
// only under its own state, so a per-run STACKBITE_STATE_DIR never does. The
// engine reads a legacy HELM_STATE_DIR only when STACKBITE_STATE_DIR is absent
// (even empty, the canonical name wins). It decides again under its locks.
async function formerSelection(saved, environment, spec) {
  const state = Object.hasOwn(environment, 'STACKBITE_STATE_DIR') ? environment.STACKBITE_STATE_DIR : environment.HELM_STATE_DIR;
  return state && path.resolve(state) !== saved?.state ? null : formerCache(saved?.home, spec);
}
async function publishCache(payload, target, spec, options) {
  await assertBaseline(options.environment, spec.platform);
  let migrate = false;
  if (options.existing) {
    const root = installationRoot(options.environment, spec.platform);
    for (const name of ['default-install.json', 'install.json']) {
      const locator = path.join(root, name);
      if (!await exists(locator)) continue;
      const saved = JSON.parse((await readSmall(locator, 16384)).toString('utf8').replace(/^\uFEFF/, ''));
      const descriptor = options.environment.STACKBITE_NPM_REGISTRATION;
      migrate = previousCacheHome(saved.home, options.cache, spec.platform)
        || !!await formerSelection(saved, options.environment, spec);
      if (!migrate && typeof saved.home === 'string' && path.isAbsolute(saved.home)
          && typeof saved.state === 'string' && path.isAbsolute(saved.state) && /^[a-f0-9]{32}$/.test(saved.installation_id)
          && (!descriptor || JSON.stringify(saved.npm_registration) === JSON.stringify(JSON.parse(descriptor)))) return;
      break;
    }
  }
  const engine = path.join(payload, 'stackbite' + (spec.platform === 'win32' ? '.exe' : ''));
  // A selection still in the previous cache layout moves to the durable image.
  const argv = options.existing && !migrate ? ['--record-install', target]
    : ['--record-install', target, '-', payload, 'cache'];
  const result = await launchNative(engine, argv, { ...options.environment, STACKBITE_HOME: payload }, options);
  if (result.code !== 0 || result.signal) fail('Runtime publication was refused');
}

function runtimeDirectory(environment, platform) {
  return path.join(installationRoot(environment, platform), 'app');
}
// This root's first locator, when it fully names an installation: the same
// shape publishCache keeps without rewriting its home.
async function establishedLocator(root) {
  for (const name of ['default-install.json', 'install.json']) {
    const locator = path.join(root, name);
    if (!await exists(locator)) continue;
    const saved = JSON.parse((await readSmall(locator, 16384)).toString('utf8').replace(/^\uFEFF/, ''));
    return saved && typeof saved.home === 'string' && path.isAbsolute(saved.home)
      && typeof saved.state === 'string' && path.isAbsolute(saved.state)
      && /^[a-f0-9]{32}$/.test(saved.installation_id) ? saved : null;
  }
  return null;
}
async function installationLocator(environment, platform) {
  const root = installationRoot(environment, platform);
  return await selectedDirectory(root, environment, platform) ? establishedLocator(root) : null;
}
// The image root when its portable identity is this release; null otherwise.
async function sameRelease(home, spec) {
  let root;
  try { root = await payloadRoot(home); } catch { return null; }
  return portableMatches(await portableMetadata(root), spec) ? root : null;
}
// Another archive of this release (a re-signed build) carries its own valid
// checksum manifest that pins its portable.json. A damaged image does not.
async function anotherPin(root) {
  try {
    const hashes = JSON.parse((await readSmall(path.join(root, 'SHA256SUMS.json'))).toString('utf8'));
    expectedMembers(hashes);
    const metadata = await readSmall(path.join(root, 'portable.json'), 16384);
    return hashes['portable.json'] === createHash('sha256').update(metadata).digest('hex');
  } catch { return false; }
}
// An image the established installation already selects outside app/: an
// explicit STACKBITE_HOME, else the locator's home. Another release or pin is
// skipped; an image of this release must otherwise carry this package's pinned
// documents, and the caller then validates its whole payload, so a damaged image
// of this release is refused, not replaced. Publication keeps the locator's
// home, except that a cache image (this host's or a former host's) is never run
// in place.
async function selectedImage(environment, spec, cache) {
  const saved = await installationLocator(environment, spec.platform);
  // A previous-cache selection keeps its existing migration path.
  if (!saved || previousCacheHome(saved.home, cache, spec.platform)) return null;
  const former = await formerCache(saved.home, spec);
  for (const home of [environment.STACKBITE_HOME, saved.home]) {
    if (typeof home !== 'string' || !path.isAbsolute(home) || home === former) continue;
    const root = await sameRelease(home, spec);
    if (!root) continue;
    try { await pinnedDocuments(root, spec); }
    catch (error) { if (await anotherPin(root)) continue; throw error; }
    return path.resolve(home);
  }
  return null;
}
// An image of this exact pinned identity, when it passes the full pinned
// validation. It is only read; a live process may use it.
async function verifiedImage(home, spec) {
  if (!home) return null;
  try { await validatePayload(home, spec); } catch { return null; }
  return home;
}
async function previousImage(legacy, cache, spec) {
  return await existingCacheDirectory(cache) && await exists(legacy) ? verifiedImage(legacy, spec) : null;
}
async function ensureBinary(spec, { cache = cacheDirectory(), runtime = null, downloadImpl = download, extractImpl = extractArchive,
  checkOnly = false, reportCached = false, includePhone = false, reuseSelected = false, progress = () => {},
  environment = process.env, publishImpl = publishCache, registrationSource = null, ...options } = {}) {
  cache = await resolveCacheDirectory(cache);
  environment = { ...environment };
  runtime = path.resolve(runtime || runtimeDirectory(environment, spec.platform));
  if (!checkOnly) {
    await admitPublication(environment, spec.platform);
    await existingCacheDirectory(cache); // Validate existing ancestors without creating a cache.
  }
  // Full identity remains SHA-256 addressed while avoiding Windows MAX_PATH.
  const cacheKey = createHash('sha256').update(JSON.stringify([spec.version, spec.commit, spec.key, spec.sha256])).digest('hex');
  const legacy = path.join(cache, `v1-${cacheKey}`);
  const target = await selectedDirectory(runtime, environment, spec.platform) ? await pinnedTarget(runtime, spec)
    : path.join(runtime, runtimeName(spec));
  const preparation = !checkOnly ? await reservePreparation(environment, spec.platform, target, registrationSource) : null;
  try {
    if (registrationSource) await registrationSource.validate();
    if (!checkOnly) await assertBaseline(environment, spec.platform);
    // Check-only callers (removal, setup --check) never publish; they may still
    // use an image of the previous cache layout, this host's or a former host's.
    const published = await selectedDirectory(runtime, environment, spec.platform) && await exists(target);
    const former = !published && reuseSelected
      ? await formerCache((await installationLocator(environment, spec.platform))?.home, spec) : null;
    const home = published ? target
      : reuseSelected && await selectedImage(environment, spec, cache)
        || (checkOnly ? (await existingCacheDirectory(cache) && await exists(legacy) ? legacy : former) : null);
    if (home) {
      if (checkOnly || reportCached) progress('validate');
      const installed = { home, executable: await validatePayload(home, spec, { includePhone }) };
      // A selected image outside app/ is its own maintenance engine.
      if (!checkOnly) await publishImpl(home, target, spec, { ...options, environment, cache, existing: true });
      if (checkOnly || reportCached) progress('ready');
      return installed;
    }
    if (checkOnly) throw notCached();
    // A verified previous-layout image is copied once into the durable target;
    // the engine then moves a cache selection there.
    const previous = await previousImage(legacy, cache, spec) || await verifiedImage(former, spec);
    if (previous) {
      progress('publish');
      await admitPublication(environment, spec.platform);
      await assertBaseline(environment, spec.platform);
      if (registrationSource) await registrationSource.validate();
      await publishImpl(previous, target, spec, { ...options, environment, cache, existing: false });
      progress('validate-published');
      const installed = { home: target, executable: await validatePayload(target, spec) };
      progress('ready');
      return installed;
    }
    // An owned system-temp stage keeps downloads out of product caches. Only the
    // verified engine below can create/publish a canonical cache installation.
    await admitPublication(environment, spec.platform);
    await assertBaseline(environment, spec.platform);
    if (registrationSource) await registrationSource.validate();
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-npm-'));
    try {
      const { payload } = await stageRelease(spec, staging, { downloadImpl, extractImpl, progress });
      progress('publish');
      await admitPublication(environment, spec.platform);
      await assertBaseline(environment, spec.platform);
      if (registrationSource) await registrationSource.validate();
      await publishImpl(payload, target, spec, { ...options, environment, cache, existing: false });
      // Validate at the final path, including a concurrent publisher's payload.
      progress('validate-published');
      const installed = { home: target, executable: await validatePayload(target, spec) };
      progress('ready');
      return installed;
    } finally { await removeStage(staging); }
  } finally {
    if (preparation) await settlePreparation(preparation, environment, spec.platform, registrationSource);
  }
}
function notCached() {
  return Object.assign(new Error('Pinned runtime is not cached; run stackbite setup.'), { code: 'STACKBITE_NOT_CACHED' });
}
// Download, size/hash, extract and validate the pinned archive inside an owned stage.
async function stageRelease(spec, staging, { downloadImpl, extractImpl, progress }) {
  const archive = path.join(staging, spec.asset), extraction = path.join(staging, 'extract');
  await fs.mkdir(extraction, { mode: 0o700 });
  progress('download');
  await downloadImpl(spec, archive);
  // download() itself verifies the exact size and SHA-256 before returning.
  // Recheck any other transport at the extraction boundary.
  progress('archive');
  if (downloadImpl !== download && ((await fs.stat(archive)).size !== spec.size
      || await hashFile(archive, LIMITS.download) !== spec.sha256)) fail('Pinned archive SHA-256 or size mismatch');
  progress('extract');
  await extractImpl(archive, extraction, spec);
  const payload = path.join(extraction, spec.root);
  progress('validate');
  return { payload, executable: await validatePayload(payload, spec) };
}
async function removeStage(staging) {
  // Only this invocation's mkdtemp directory is owned.
  if (path.dirname(staging) !== path.resolve(os.tmpdir()) || !path.basename(staging).startsWith('stackbite-npm-')) fail('Unsafe staging cleanup path');
  await fs.rm(staging, { recursive: true, force: true });
}
// The fixed engine may hand removal to a helper started from its own image
// (parent_resume.runtime). While the same journal still names that image, the
// stage is the helper's runtime and stays; finalization removes the journal.
async function stageStillNeeded(pending, staging) {
  let record;
  try { record = JSON.parse((await readSmall(pending.journal, 8 * 1024 * 1024)).toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return false; return true; }
  const runtime = record?.parent_resume?.runtime?.path;
  if (record?.request_id !== pending.request || typeof runtime !== 'string' || !path.isAbsolute(runtime)) return false;
  const roots = [staging, await fs.realpath(staging)];
  return roots.some(root => inside(root, path.resolve(runtime)));
}
// Continue an accepted removal with a private, verified copy of this package's
// pinned runtime. Nothing is published: no cache, locator, preparation or
// installation identity is created, and only the original argv runs.
async function continueAcceptedRemoval(spec, argv, environment, options) {
  const pending = await acceptedRemovalWithoutCapsule(environment, spec.platform);
  if (!pending) return null;
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-npm-'));
  let retained = false;
  try {
    const { payload, executable } = await stageRelease(spec, staging, {
      downloadImpl: options.downloadImpl || download, extractImpl: options.extractImpl || extractArchive,
      progress: options.progress || stageReporter(options.stderr || process.stderr) });
    if (JSON.stringify(await acceptedRemovalWithoutCapsule(environment, spec.platform)) !== JSON.stringify(pending)) {
      fail('Stackbite removal changed while staging its runtime; nothing was run');
    }
    const npm = await require('./uninstall-registration').descriptor(options);
    const result = await launchNative(executable, argv, { ...environment,
      ...(npm ? { STACKBITE_NPM_REGISTRATION: JSON.stringify(npm) } : {}),
      STACKBITE_HOME: path.resolve(payload) }, options);
    retained = await stageStillNeeded(pending, staging);
    return result;
  } finally {
    if (!retained) await removeStage(staging);
  }
}
async function launchNative(executable, argv, environment, { spawnImpl = spawn, signalSource = process } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, argv, { env: environment, stdio: 'inherit', shell: false });
    const handlers = new Map();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => child.kill(signal);
      handlers.set(signal, handler);
      signalSource.on(signal, handler);
    }
    function cleanup() { for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler); }
    child.once('error', () => { cleanup(); reject(new Error('Cannot start the verified native Stackbite executable')); });
    child.once('exit', (code, signal) => { cleanup(); resolve({ code, signal }); });
  });
}
// Before the first install, --help/--version answer from this package's pin
// instead of downloading a runtime; the launcher only ever runs that build.
async function coldAnswer(argv, spec, runtime, { stdout = process.stdout, stderr = process.stderr }) {
  if (argv.length !== 1 || !['--version', '--help', '-h'].includes(argv[0])) return null;
  try { if (await exists(await pinnedTarget(runtime, spec))) return null; } catch { return null; }
  if (argv[0] === '--version') {
    stdout.write(`Stackbite ${spec.version} (${spec.commit})\n`);
    stderr.write('Stackbite: this is the pinned release; its runtime is not installed yet. Run stackbite setup to install it.\n');
  } else {
    stdout.write('usage: stackbite [--help | --version] | stackbite setup [--check] | stackbite [COMMAND ...]\n\n'
      + `The pinned Stackbite ${spec.version} runtime is not installed yet. Run stackbite setup to\n`
      + 'install it (or run any command); stackbite --help then shows the full reference.\n');
  }
  return { code: 0, signal: null };
}
async function main(argv = process.argv.slice(2), options = {}) {
  const setup = parseSetup(argv);
  const removing = ['uninstall', 'delete'].includes(argv[0]);
  const manifest = options.manifest || require('../release.json');
  const platform = options.platform || process.platform;
  const environment = { ...(options.environment || process.env) };
  // Only the package's existing descriptor producer supplies registration input.
  // The engine validates package membership and tool/file identity before save.
  delete environment.STACKBITE_NPM_REGISTRATION;
  const { descriptor, explicitApply } = require('./uninstall-registration');
  let npm = !removing ? await descriptor(options) : null;
  const registrationSource = await pinRegistration(npm, options);
  try {
    if (npm) environment.STACKBITE_NPM_REGISTRATION = JSON.stringify(npm);
    const spec = releaseSpec(manifest, platform, options.arch || process.arch, options);
    const cold = await coldAnswer(argv, spec, options.runtime || runtimeDirectory(environment, platform), options);
    if (cold) return cold;
    // First install always verifies everything. Cached TUI/runtime starts defer only
    // Phone; explicit phone/setup/removal commands retain the full pinned check.
    let installed;
    try { installed = await timing.phase(environment, 'launcher.ensure', () => ensureBinary(spec, { ...options,
      environment, registrationSource,
      cache: options.cache || cacheDirectory(environment, platform),
      checkOnly: removing || setup?.checkOnly || false, reportCached: Boolean(setup), reuseSelected: !removing,
      includePhone: removing || Boolean(setup) || argv[0] === 'phone',
      progress: options.progress || stageReporter(options.stderr || process.stderr) })); }
    catch (error) {
      if (!removing) throw error;
      const { resumeWithoutRuntime, registrationOnly } = require('./uninstall-registration');
      const recovered = await resumeWithoutRuntime(argv, environment, launchNative, options);
      if (recovered) return recovered;
      // Only an absent runtime qualifies; a corrupt or foreign cache stays an error.
      if (error.code === 'STACKBITE_NOT_CACHED' && explicitApply(argv)) {
        const continued = await continueAcceptedRemoval(spec, argv, environment, options);
        if (continued) return continued;
      }
      const registration = await registrationOnly(argv, environment, launchNative, options);
      if (registration) return registration;
      throw error;
    }
    if (setup) return { code: 0, signal: null };
    timing.mark(environment, 'launcher.exec');
    // The bundled runtime owns state discovery and migration for every entrypoint.
    if (removing && explicitApply(argv)) npm = await descriptor(options);
    return launchNative(installed.executable, argv, { ...environment,
      ...(npm ? { STACKBITE_NPM_REGISTRATION: JSON.stringify(npm) } : {}),
      STACKBITE_HOME: path.resolve(installed.home) }, options);
  } finally { if (registrationSource) await registrationSource.close(); }
}
module.exports = { releaseSpec, validatePayload, ensureBinary, launchNative, main };
