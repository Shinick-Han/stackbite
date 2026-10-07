'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { LIMITS, fail, memberPath, inside, hashFile, readSmall, exists, safeDirectory } = require('./common');
const { download } = require('./download');
const { extractArchive } = require('./archive');
const { stateDirectory, cacheDirectory } = require('./state');
const packageVersion = require('../../../package.json').version;

function releaseSpec(manifest, platform = process.platform, arch = process.arch, runtime = {}) {
  const key = `${platform}-${arch}`;
  if (!['win32-x64', 'linux-x64'].includes(key)) fail(`Stackbite does not have a native release for ${key}; supported platforms are Windows x64 and Linux x64.`);
  if (platform === 'linux' && (process.platform === 'linux' || Object.hasOwn(runtime, 'glibcVersionRuntime'))) {
    const glibc = Object.hasOwn(runtime, 'glibcVersionRuntime')
      ? runtime.glibcVersionRuntime : process.report.getReport().header.glibcVersionRuntime;
    if (typeof glibc !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(glibc)) {
      fail('Stackbite requires Linux x64 with glibc; Alpine/musl Linux is unsupported. No release was downloaded.');
    }
  }
  if (manifest.schema !== 1 || manifest.version !== packageVersion || !/^[a-f0-9]{40}$/.test(manifest.commit)
      || manifest.repository !== 'Shinick-Han/stackbite') fail('Invalid pinned Stackbite release identity');
  const spec = manifest.platforms?.[key];
  const host = platform === 'win32' ? 'windows-x64' : 'linux-x86_64';
  const root = `stackbite-${manifest.version}-${host}-${manifest.commit.slice(0, 12)}`;
  const asset = root + (platform === 'win32' ? '.zip' : '.tar.gz');
  if (!spec || spec.root !== root || spec.asset !== asset
      || spec.url !== `https://github.com/${manifest.repository}/releases/download/v${manifest.version}/${asset}`
      || ![spec.sha256, spec.manifestSha256, spec.metadataSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
      || !Number.isSafeInteger(spec.size) || spec.size <= 0 || spec.size > LIMITS.download) fail('Invalid pinned release asset');
  return { ...spec, key, platform, host, version: manifest.version, commit: manifest.commit };
}
async function validatePayload(directory, spec) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Cached release root is not a regular directory');
  const root = await fs.realpath(directory);
  const manifestPath = path.join(root, 'SHA256SUMS.json'), metadataPath = path.join(root, 'portable.json');
  const manifestBytes = await readSmall(manifestPath), metadataBytes = await readSmall(metadataPath, 16384);
  if (createHash('sha256').update(manifestBytes).digest('hex') !== spec.manifestSha256
      || createHash('sha256').update(metadataBytes).digest('hex') !== spec.metadataSha256) fail('Pinned release manifest or metadata SHA-256 mismatch');
  const hashes = JSON.parse(manifestBytes.toString('utf8'));
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  if (!hashes || Array.isArray(hashes) || typeof hashes !== 'object' || !Object.keys(hashes).length
      || Object.keys(hashes).length > LIMITS.members) fail('Invalid release file manifest');
  const expected = new Set();
  for (const [name, digest] of Object.entries(hashes)) {
    if (memberPath(name) !== name || !/^[a-f0-9]{64}$/.test(digest) || ['SHA256SUMS.json', 'SHA256SUMS'].includes(name)) fail('Invalid release manifest member');
    expected.add(name);
  }
  if (!expected.has('portable.json') || !expected.has('runtime/build-info.json')) fail('Required release metadata is missing');
  const actual = new Set();
  let total = 0, entries = 0;
  async function visit(directoryPath) {
    for (const name of await fs.readdir(directoryPath)) {
      if (++entries > LIMITS.members * 2) fail('Cached release has too many entries');
      const target = path.join(directoryPath, name), relative = path.relative(root, target).split(path.sep).join('/');
      memberPath(relative);
      const entry = await fs.lstat(target);
      if (entry.isDirectory()) { await visit(target); continue; }
      if (!entry.isFile() && !entry.isSymbolicLink()) fail('Release contains a special file');
      const resolved = await fs.realpath(target);
      if (!inside(root, resolved)) fail('Release link escapes the cache root');
      const resolvedInfo = await fs.lstat(resolved);
      if (!resolvedInfo.isFile() || resolvedInfo.size > LIMITS.member) fail('Release link does not resolve to a bounded regular file');
      total += resolvedInfo.size;
      if (total > LIMITS.expanded) fail('Cached release exceeds expansion limit');
      actual.add(relative);
      if (expected.has(relative) && await hashFile(resolved) !== hashes[relative]) fail(`Release file SHA-256 mismatch: ${relative}`);
    }
  }
  await visit(root);
  expected.add('SHA256SUMS.json');
  if (spec.platform === 'linux') {
    expected.add('SHA256SUMS');
    const text = await readSmall(path.join(root, 'SHA256SUMS'));
    if (text.toString('utf8') !== Object.entries(hashes).map(([name, digest]) => `${digest}  ${name}\n`).join('')) fail('Linux checksum text disagrees with pinned manifest');
  }
  if (actual.size !== expected.size || [...actual].some(name => !expected.has(name))) fail('Release files disagree with pinned manifest');
  const build = JSON.parse((await readSmall(path.join(root, 'runtime', 'build-info.json'), 16384)).toString('utf8'));
  for (const value of [metadata, build]) {
    if (value.version !== spec.version || value.commit !== spec.commit || value.product !== 'Stackbite'
        || (value.command !== undefined && value.command !== 'stackbite')
        || (value.platform !== undefined && value.platform !== spec.host)) fail('Release product/version/commit identity mismatch');
  }
  const executable = path.join(root, spec.platform === 'win32' ? 'stackbite.exe' : 'stackbite');
  const image = await fs.lstat(executable);
  if (!image.isFile() || image.isSymbolicLink()) fail('Native release executable is missing or a link');
  const file = await fs.open(executable, 'r');
  try {
    const magic = Buffer.alloc(4);
    if ((await file.read(magic, 0, 4, 0)).bytesRead !== 4
        || !(spec.platform === 'win32' ? magic.subarray(0, 2).equals(Buffer.from('MZ')) : magic.equals(Buffer.from([0x7f, 69, 76, 70])))) fail('Invalid native executable identity');
  } finally { await file.close(); }
  if (spec.platform === 'linux' && process.platform !== 'win32' && !(image.mode & 0o111)) fail('Native release executable has no execute permission');
  return executable;
}
async function ensureBinary(spec, { cache = cacheDirectory(), downloadImpl = download, extractImpl = extractArchive } = {}) {
  cache = path.resolve(cache);
  await safeDirectory(cache);
  const target = path.join(cache, `${spec.version}-${spec.commit}-${spec.key}-${spec.sha256}`);
  if (await exists(target)) return { home: target, executable: await validatePayload(target, spec) };
  const staging = await fs.mkdtemp(path.join(cache, '.staging-'));
  try {
    const archive = path.join(staging, spec.asset), extraction = path.join(staging, 'extract');
    await fs.mkdir(extraction, { mode: 0o700 });
    await downloadImpl(spec, archive);
    // Recheck at the extraction boundary, including for injected test transports.
    if ((await fs.stat(archive)).size !== spec.size || await hashFile(archive, LIMITS.download) !== spec.sha256) fail('Pinned archive SHA-256 or size mismatch');
    await extractImpl(archive, extraction, spec);
    const payload = path.join(extraction, spec.root);
    await validatePayload(payload, spec);
    try { await fs.rename(payload, target); }
    catch (error) {
      // Another process may have installed the same immutable payload first.
      // Never delete/rewrite its directory or try a destructive rename retry.
      if (!await exists(target)) throw error;
    }
    return { home: target, executable: await validatePayload(target, spec) };
  } finally {
    // Only this mkdtemp handle is owned by this invocation.
    if (!inside(cache, staging) || path.dirname(staging) !== cache) fail('Unsafe staging cleanup path');
    await fs.rm(staging, { recursive: true, force: true });
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
async function main(argv = process.argv.slice(2), options = {}) {
  const manifest = options.manifest || require('../release.json');
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const spec = releaseSpec(manifest, platform, options.arch || process.arch, options);
  const state = await stateDirectory(environment, platform);
  const installed = await ensureBinary(spec, { ...options, cache: options.cache || cacheDirectory(environment, platform) });
  return launchNative(installed.executable, argv, { ...environment, HELM_HOME: path.resolve(installed.home),
    HELM_STATE_DIR: state }, options);
}
module.exports = { releaseSpec, validatePayload, ensureBinary, launchNative, main };
