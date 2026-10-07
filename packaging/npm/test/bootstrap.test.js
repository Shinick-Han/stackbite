'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const { releaseSpec, ensureBinary, validatePayload, launchNative, main } = require('../lib/bootstrap');
const { extractArchive, validateEntries, tarEntries } = require('../lib/archive');
const { stateDirectory, cacheDirectory, managedState, windowsManagedState } = require('../lib/state');
const { fixture, digest, tar, zip } = require('./fixtures');

async function owned(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-npm-owned-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const writeFixture = value => async (spec, target) => fs.writeFile(target, value.bytes, { flag: 'wx' });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const launcher = (state, image) => `#!/bin/sh\n# Helm managed launcher\nif [ -z "\${HELM_STATE_DIR:-}" ]; then\n  HELM_STATE_DIR=${quote(state)}\n  export HELM_STATE_DIR\nfi\nexec ${quote(image)} "$@"\n`;

test('package contract has no install hook/runtime dependencies and ships only the bootstrapper', () => {
  const pkg = require('../../../package.json');
  assert.equal(pkg.name, 'stackbite'); assert.equal(pkg.version, '0.5.10'); assert.equal(pkg.license, 'UNLICENSED');
  assert.equal(pkg.engines.node, '>=20'); assert.equal(pkg.bin.stackbite, 'packaging/npm/bin/stackbite.js');
  assert.equal(pkg.dependencies, undefined); assert.equal(pkg.scripts.postinstall, undefined);
  assert.deepEqual(pkg.files, ['packaging/npm/bin/', 'packaging/npm/lib/', 'packaging/npm/release.json']);
});
test('shipped pin identity is valid; unsupported architectures and alternate URLs fail before download', () => {
  const manifest = require('../release.json');
  for (const platform of ['win32', 'linux']) assert.equal(releaseSpec(manifest, platform, 'x64').version, '0.5.10');
  for (const [platform, arch] of [['darwin', 'x64'], ['linux', 'arm64'], ['win32', 'arm64']]) {
    assert.throws(() => releaseSpec(manifest, platform, arch), /supported platforms/);
  }
  const value = fixture();
  value.manifest.platforms['linux-x64'].url += '?alternate=true';
  assert.throws(() => releaseSpec(value.manifest, 'linux', 'x64'), /pinned release asset/);
});
test('Alpine/musl Linux fails explicitly before state inspection, cache creation or download', async t => {
  const area = await owned(t), value = fixture(), cache = path.join(area, 'cache');
  await assert.rejects(main(['--version'], { manifest: value.manifest, platform: 'linux', arch: 'x64',
    glibcVersionRuntime: undefined, cache, environment: {},
    downloadImpl: () => assert.fail('musl must not download any release') }), /Alpine\/musl Linux is unsupported/);
  await assert.rejects(fs.stat(cache), { code: 'ENOENT' });
  assert.equal(releaseSpec(value.manifest, 'linux', 'x64', { glibcVersionRuntime: '2.35' }).key, 'linux-x64');
});
for (const platform of ['linux', 'win32']) test(`native tar installs and revalidates pinned ${platform} fixture without another download`, async t => {
  if (process.platform !== 'win32' && platform === 'win32') return t.skip('ZIP extraction requires Windows native bsdtar');
  const cache = await owned(t), value = fixture(platform), spec = releaseSpec(value.manifest, platform, 'x64');
  let calls = 0;
  const downloadImpl = async (...args) => { calls++; await writeFixture(value)(...args); };
  const first = await ensureBinary(spec, { cache, downloadImpl });
  const handle = await fs.open(first.executable, 'r');
  try {
    const second = await ensureBinary(spec, { cache, downloadImpl });
    assert.deepEqual(second, first); assert.equal(calls, 1);
    assert.deepEqual(await fs.readdir(cache), [path.basename(first.home)]);
  } finally { await handle.close(); }
  assert.equal(await validatePayload(first.home, spec), first.executable);
});
test('concurrent initial invocations publish one immutable cache and clean only their staging directories', async t => {
  const cache = await owned(t), value = fixture(), spec = releaseSpec(value.manifest, 'linux', 'x64');
  let downloads = 0;
  const downloadImpl = async (...args) => { downloads++; await new Promise(resolve => setTimeout(resolve, 20)); await writeFixture(value)(...args); };
  const results = await Promise.all([ensureBinary(spec, { cache, downloadImpl }), ensureBinary(spec, { cache, downloadImpl })]);
  assert.deepEqual(results[0], results[1]); assert.equal(downloads, 2);
  assert.deepEqual(await fs.readdir(cache), [path.basename(results[0].home)]);
});
test('altered cached manifest cannot bless a changed binary, and corrupt cache is never replaced/deleted', async t => {
  const cache = await owned(t), value = fixture(), spec = releaseSpec(value.manifest, 'linux', 'x64');
  const result = await ensureBinary(spec, { cache, downloadImpl: writeFixture(value) });
  const changed = Buffer.from('\x7fELFattacker payload');
  await fs.writeFile(result.executable, changed);
  const manifestPath = path.join(result.home, 'SHA256SUMS.json');
  const hashes = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  hashes.stackbite = digest(changed); await fs.writeFile(manifestPath, JSON.stringify(hashes));
  await assert.rejects(ensureBinary(spec, { cache, downloadImpl: () => assert.fail('corrupt cache must not trigger a download/replacement') }), /manifest or metadata SHA-256/);
  assert.deepEqual(await fs.readFile(result.executable), changed);
  assert.ok((await fs.stat(result.home)).isDirectory());
});
test('per-file hash and portable product/version/commit identities are enforced', async t => {
  const area = await owned(t);
  const value = fixture(), spec = releaseSpec(value.manifest, 'linux', 'x64');
  const result = await ensureBinary(spec, { cache: path.join(area, 'valid'), downloadImpl: writeFixture(value) });
  await fs.writeFile(path.join(result.home, 'runtime', 'owned.txt'), 'tampered');
  await assert.rejects(validatePayload(result.home, spec), /file SHA-256 mismatch/);
  for (const change of [{ product: 'Helm' }, { version: '0.0.1' }, { commit: 'a'.repeat(40) }]) {
    const bad = fixture('linux', change), badSpec = releaseSpec(bad.manifest, 'linux', 'x64');
    const cache = path.join(area, digest(Buffer.from(JSON.stringify(change))));
    await assert.rejects(ensureBinary(badSpec, { cache, downloadImpl: writeFixture(bad) }), /identity mismatch/);
    assert.deepEqual(await fs.readdir(cache), []);
  }
});
test('archive SHA-256 is checked before any extractor and staging is removed after failure', async t => {
  const cache = await owned(t), value = fixture(), spec = releaseSpec(value.manifest, 'linux', 'x64');
  await assert.rejects(ensureBinary(spec, { cache, downloadImpl: async (_, target) => fs.writeFile(target, Buffer.alloc(value.bytes.length)),
    extractImpl: () => assert.fail('unverified archive must never be extracted') }), /archive SHA-256/);
  assert.deepEqual(await fs.readdir(cache), []);
});
test('unsafe real archive paths/types are rejected before spawning native tar', async t => {
  const area = await owned(t), value = fixture();
  const cases = [
    [{ name: value.root + '/../escape', data: 'bad' }],
    [{ name: value.root + '/link', type: '2', link: '../../escape' }],
    [{ name: value.root + '/link', type: '1', link: value.root + '/file' }],
    [{ name: value.root + '/special', type: '3' }]
  ];
  for (let index = 0; index < cases.length; index++) {
    const archive = path.join(area, `bad-${index}.tar.gz`);
    await fs.writeFile(archive, gzipSync(tar(cases[index])));
    await assert.rejects(extractArchive(archive, area, value.pinned, { spawnImpl: () => assert.fail('preflight failure must not invoke tar') }), /archive|TAR/i);
  }
  const win = fixture('win32');
  for (const records of [[{ name: win.root + '/file', mode: 0o120777, data: '/outside' }],
    [{ name: win.root + '/A', data: 'one' }, { name: win.root + '/a', data: 'two' }]]) {
    const archive = path.join(area, 'bad.zip'); await fs.writeFile(archive, zip(records));
    await assert.rejects(extractArchive(archive, area, win.pinned, { spawnImpl: () => assert.fail('preflight failure must not invoke tar') }), /ZIP|Duplicate/);
  }
});
test('member validation refuses directory links, dangling/cyclic links and linked parents', () => {
  const root = fixture().root;
  for (const entries of [
    [{ name: root + '/link', kind: 'link', link: 'missing', size: 0 }],
    [{ name: root + '/dir', kind: 'directory', size: 0 }, { name: root + '/link', kind: 'link', link: 'dir', size: 0 }],
    [{ name: root + '/link', kind: 'link', link: 'file', size: 0 }, { name: root + '/link/child', kind: 'file', size: 1 }, { name: root + '/file', kind: 'file', size: 1 }],
    [{ name: root + '/a', kind: 'link', link: 'b', size: 0 }, { name: root + '/b', kind: 'link', link: 'a', size: 0 }]
  ]) assert.throws(() => validateEntries(entries, root, false), /Archive/);
  assert.doesNotThrow(() => validateEntries([{ name: root + '/runtime/lib', kind: 'file', size: 1 },
    { name: root + '/runtime/link', kind: 'link', link: 'lib', size: 0 }], root, false));
});
test('ZIP actual expansion is bounded before native extraction even with dishonest declared sizes', async t => {
  const area = await owned(t), value = fixture('win32'), archive = path.join(area, 'expansion.zip');
  await fs.writeFile(archive, zip([{ name: value.root + '/bomb', data: Buffer.alloc(65536, 65), declaredSize: 1 }]));
  await assert.rejects(extractArchive(archive, area, value.pinned, { spawnImpl: () => assert.fail('native tar must not see an expansion attack') }), /expansion exceeds/);
});
test('TAR PAX path/time metadata is interpreted exactly and cache ancestors reject symlinks', async t => {
  const area = await owned(t), value = fixture(), archive = path.join(area, 'pax.tar');
  function pax(key, value) {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;
    while (String(length).length + body.length !== length) length = String(length).length + body.length;
    return String(length) + body;
  }
  const name = value.root + '/runtime/long-owned-file';
  await fs.writeFile(archive, tar([{ name: '././@PaxHeader', type: 'x', data: pax('path', name) + pax('mtime', '123.25') },
    { name: 'header-name', data: 'owned fixture' }]));
  assert.deepEqual((await tarEntries(archive)).map(entry => entry.name), [name]);
  const outside = path.join(area, 'outside'), link = path.join(area, 'cache-link');
  await fs.mkdir(outside);
  try { await fs.symlink(outside, link, 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Host cannot create disposable directory symlinks'); throw error; }
  await assert.rejects(ensureBinary(releaseSpec(value.manifest, 'linux', 'x64'), { cache: path.join(link, 'cache'),
    downloadImpl: () => assert.fail('linked cache directory must not download') }), /Cache directory/);
  assert.deepEqual(await fs.readdir(outside), []);
});
test('Windows state honors explicit override and default-install then legacy install without changing auth', async t => {
  const area = await owned(t), local = path.join(area, 'local'), legacy = path.join(local, 'Helm');
  await fs.mkdir(legacy, { recursive: true });
  const token = path.join(legacy, '.office_secret_token'); await fs.writeFile(token, 'owned auth fixture');
  const env = { LOCALAPPDATA: local };
  await fs.writeFile(path.join(legacy, 'install.json'), JSON.stringify({ state: path.join(area, 'old custom state') }));
  assert.equal(await stateDirectory(env, 'win32'), path.join(area, 'old custom state'));
  await fs.writeFile(path.join(legacy, 'default-install.json'), JSON.stringify({ state: path.join(area, 'default custom state') }));
  assert.equal(await stateDirectory(env, 'win32'), path.join(area, 'default custom state'));
  assert.equal(await stateDirectory({ ...env, HELM_STATE_DIR: path.join(area, 'explicit') }, 'win32'), path.join(area, 'explicit'));
  assert.equal(await fs.readFile(token, 'utf8'), 'owned auth fixture');
  assert.equal(cacheDirectory(env, 'win32'), path.join(local, 'Stackbite', 'cache'));
});
test('config-free Windows portable launchers preserve custom state and honor JSON/env precedence', async t => {
  const area = await owned(t), local = path.join(area, 'local'), profile = path.join(area, 'profile');
  const bin = path.join(profile, '.local', 'bin'), app = path.join(local, 'Helm', 'app', '0.5.10-owned');
  await fs.mkdir(bin, { recursive: true }); await fs.mkdir(path.join(local, 'Helm'), { recursive: true });
  const env = { LOCALAPPDATA: local, USERPROFILE: profile };
  const custom = path.join(area, 'portable custom state with spaces');
  const command = (state, image = 'stackbite', marked = true) => `@echo off\r\n${marked ? 'rem Stackbite managed launcher\r\n' : ''}setlocal\r\nset "HELM_HOME=${app}"\r\nset "HELM_STATE_DIR=${state}"\r\n"${app}\\${image}.exe" %*\r\nexit /b %errorlevel%\r\n`;
  await fs.writeFile(path.join(bin, 'stackbite-portable.cmd'), command(custom));
  // The real installer preserves an existing EXE and may not create stackbite.cmd.
  await fs.writeFile(path.join(bin, 'stackbite.exe'), 'owned legacy executable');
  assert.equal(await stateDirectory(env, 'win32'), custom);
  await fs.writeFile(path.join(bin, 'helm.cmd'), command(path.join(area, 'legacy'), 'helm', false));
  assert.equal(await stateDirectory(env, 'win32'), custom);
  await fs.writeFile(path.join(bin, 'stackbite.cmd'), command(path.join(area, 'canonical custom')));
  assert.equal(await stateDirectory(env, 'win32'), path.join(area, 'canonical custom'));
  await fs.writeFile(path.join(local, 'Helm', 'install.json'), JSON.stringify({ state: path.join(area, 'JSON legacy') }));
  assert.equal(await stateDirectory(env, 'win32'), path.join(area, 'JSON legacy'));
  await fs.writeFile(path.join(local, 'Helm', 'default-install.json'), JSON.stringify({ state: path.join(area, 'JSON default') }));
  assert.equal(await stateDirectory(env, 'win32'), path.join(area, 'JSON default'));
  assert.equal(await stateDirectory({ ...env, HELM_STATE_DIR: path.join(area, 'explicit') }, 'win32'), path.join(area, 'explicit'));
  assert.equal(await fs.readFile(path.join(bin, 'stackbite.exe'), 'utf8'), 'owned legacy executable');
});
test('Windows launcher fallback ignores malformed/unmanaged/injected scripts without executing them', async t => {
  const area = await owned(t), local = path.join(area, 'local'), profile = path.join(area, 'profile');
  const bin = path.join(profile, '.local', 'bin'), appRoot = path.join(local, 'Helm', 'app');
  const app = path.join(appRoot, 'owned'), custom = path.join(area, 'owned custom state');
  await fs.mkdir(bin, { recursive: true });
  const env = { LOCALAPPDATA: local, USERPROFILE: profile };
  const valid = `@echo off\nrem Stackbite managed launcher\nsetlocal\nset "HELM_HOME=${app}"\nset "HELM_STATE_DIR=${custom}"\n"${app}\\helm.exe" %*\nexit /b %errorlevel%\n`;
  await fs.writeFile(path.join(bin, 'helm-portable.cmd'), valid);
  for (const unsafe of [valid + 'echo injected > sentinel\n', valid.replace('setlocal\n', 'setlocal & echo injected > sentinel\n'),
    valid.replace(custom, '%SECRET%'), valid.replace('" %*', '" %* & echo injected > sentinel'),
    valid.replaceAll(app, path.join(area, 'unmanaged-home')), '@echo off\necho unmanaged\n']) {
    await fs.writeFile(path.join(bin, 'stackbite.cmd'), unsafe);
    assert.equal(windowsManagedState(unsafe, appRoot), null);
    assert.equal(await stateDirectory(env, 'win32'), custom);
  }
  await fs.rm(path.join(bin, 'helm-portable.cmd'));
  assert.equal(await stateDirectory(env, 'win32'), path.join(local, 'Helm', 'state'));
  assert.deepEqual((await fs.readdir(bin)).sort(), ['stackbite.cmd']);
  assert.equal(await fs.readFile(path.join(bin, 'stackbite.cmd'), 'utf8'), '@echo off\necho unmanaged\n');
});
test('Linux legacy custom state is parsed literally, with no sourcing or shell execution', async t => {
  const area = await owned(t), home = path.join(area, 'home'), bin = path.join(home, '.local', 'bin');
  await fs.mkdir(bin, { recursive: true });
  const custom = path.join(area, "custom ' state $(touch sentinel)");
  await fs.writeFile(path.join(bin, 'helm'), launcher(custom, path.join(area, 'old', 'helm')));
  assert.equal(await stateDirectory({ HOME: home }, 'linux'), custom);
  const malicious = launcher(path.join(area, 'wrong'), path.join(area, 'old', 'stackbite')) + 'touch sentinel\n';
  await fs.writeFile(path.join(bin, 'stackbite'), malicious);
  assert.equal(await stateDirectory({ HOME: home }, 'linux'), custom);
  assert.equal(managedState(launcher(custom, '/old/helm').replace('fi\n', 'fi; touch sentinel\n')), null);
  assert.equal(await stateDirectory({ HOME: home, HELM_STATE_DIR: path.join(area, 'explicit') }, 'linux'), path.join(area, 'explicit'));
  assert.equal(cacheDirectory({ HOME: home, XDG_CACHE_HOME: path.join(area, 'xdg') }, 'linux'), path.join(area, 'xdg', 'stackbite'));
  await fs.rm(path.join(bin, 'helm')); await fs.rm(path.join(bin, 'stackbite'));
  assert.equal(await stateDirectory({ HOME: home, XDG_STATE_HOME: path.join(area, 'state') }, 'linux'), path.join(area, 'state', 'helm'));
  assert.deepEqual(await fs.readdir(bin), []);
});
test('native child receives literal argv/inherited stdio, custom state, actual home and exit status', async t => {
  const area = await owned(t), value = fixture(), spec = releaseSpec(value.manifest, 'linux', 'x64');
  const stub = path.join(area, 'owned-stub.js'), receipt = path.join(area, 'receipt.json');
  await fs.writeFile(stub, "require('node:fs').writeFileSync(process.env.OWNED_RECEIPT, JSON.stringify({argv:process.argv.slice(2),home:process.env.HELM_HOME,state:process.env.HELM_STATE_DIR}));process.exit(7);");
  const argv = ['argument with spaces', '"quoted"', '$() ; &', '--rooms'];
  let invocation;
  const result = await main(argv, { manifest: value.manifest, platform: 'linux', arch: 'x64', cache: path.join(area, 'cache'),
    downloadImpl: writeFixture(value), environment: { ...process.env, HELM_STATE_DIR: path.join(area, 'owned state'), OWNED_RECEIPT: receipt },
    spawnImpl(executable, args, options) { invocation = { executable, args, options }; return spawn(process.execPath, [stub, ...args], options); } });
  assert.deepEqual(result, { code: 7, signal: null });
  assert.equal(invocation.options.stdio, 'inherit'); assert.equal(invocation.options.shell, false);
  const actual = JSON.parse(await fs.readFile(receipt, 'utf8'));
  assert.deepEqual(actual.argv, argv); assert.equal(actual.state, path.join(area, 'owned state'));
  assert.equal(actual.home, path.dirname(invocation.executable));
  assert.equal(path.basename(invocation.executable), 'stackbite');
  assert.ok(actual.home.endsWith(`${spec.key}-${spec.sha256}`));
});
test('parent signals are forwarded and child signal termination/handlers are preserved', async () => {
  const source = new EventEmitter(), child = new EventEmitter(), forwarded = [];
  child.kill = signal => forwarded.push(signal);
  const pending = launchNative('/owned/stackbite', [], {}, { signalSource: source, spawnImpl: () => child });
  source.emit('SIGINT'); assert.deepEqual(forwarded, ['SIGINT']);
  child.emit('exit', null, 'SIGINT'); assert.deepEqual(await pending, { code: null, signal: 'SIGINT' });
  assert.equal(source.listenerCount('SIGINT'), 0); assert.equal(source.listenerCount('SIGTERM'), 0);
});
