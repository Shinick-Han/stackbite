'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { main, ensureBinary, releaseSpec, launchNative } = require('../lib/bootstrap');
const { fixture } = require('./fixtures');
const pythonOracle = require('./python-oracle');

async function owned(t) {
  const area = await fs.mkdtemp(path.join(os.tmpdir(), 'a4n-'));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) if (['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT'].includes(key.toUpperCase())) environment[key] = value;
  for (const [key, name] of Object.entries({ HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local', APPDATA: 'config',
    XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'states', XDG_CACHE_HOME: 'cache', STACKBITE_STATE_DIR: 'state' })) environment[key] = path.join(area, name);
  environment.PYTHONDONTWRITEBYTECODE = '1';
  const root = path.join(area, process.platform === 'win32' ? 'local/Stackbite' : 'data/stackbite');
  const cache = process.platform === 'win32' ? path.join(root, 'cache') : path.join(area, 'cache/stackbite');
  const value = fixture(process.platform, {}, { [process.platform === 'win32' ? 'install.ps1' : 'install.sh']: Buffer.from('# inert installer') });
  return { area, environment, root, cache, app: path.join(root, 'app'), value };
}
async function accepted(c, phase = 'prepared') {
  await fs.mkdir(c.root, { recursive: true });
  await fs.writeFile(path.join(c.root, '.stackbite-uninstall.json'), JSON.stringify({ schema: 'stackbite.uninstall.v1',
    phase, request_id: 'owned-removal', accepted: true, state: c.environment.STACKBITE_STATE_DIR }));
}
function settings(c, extra = {}) {
  return { manifest: c.value.manifest, platform: process.platform, arch: process.arch, cache: c.cache,
    environment: c.environment, progress: () => {}, ...extra };
}
function actualEngine(c, calls, before = async () => {}) {
  return (engine, args, config) => {
    calls.push({ engine, args, environment: config.env });
    if (args[0] !== '--record-install') {
      const child = new EventEmitter();
      process.nextTick(() => child.emit('exit', 0, null));
      return child;
    }
    // Spawn the real source maintenance entry with the already verified inert
    // payload, so publication uses Python's real OS locks and U2 validator.
    const child = new EventEmitter();
    child.kill = () => false;
    before().then(() => {
      const processChild = spawn(process.env.STACKBITE_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
        ['-B', path.join(pythonOracle.root(), 'stackbite.py'), ...args], config);
      child.kill = signal => processChild.kill(signal);
      processChild.once('exit', (...values) => child.emit('exit', ...values));
      processChild.once('error', error => child.emit('error', error));
    }).catch(error => child.emit('error', error));
    return child;
  };
}

async function globalPackage(c) {
  const prefix = path.join(c.area, 'prefix');
  const packageRoot = path.join(prefix, process.platform === 'win32' ? 'node_modules/stackbite' : 'lib/node_modules/stackbite');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'stackbite', bin: { stackbite: 'packaging/npm/bin/stackbite.js' } }));
  for (const relative of ['bin/stackbite.js', 'lib/bootstrap.js', 'lib/uninstall-registration.js']) {
    const destination = path.join(packageRoot, 'packaging/npm', relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(__dirname, '..', relative), destination);
  }
  const shim = path.join(prefix, process.platform === 'win32' ? 'stackbite.cmd' : 'bin/stackbite');
  await fs.mkdir(path.dirname(shim), { recursive: true });
  if (process.platform === 'win32') await fs.writeFile(shim, '@echo off\nnode "%~dp0node_modules\\stackbite\\packaging\\npm\\bin\\stackbite.js" %*\n');
  else await fs.symlink('../lib/node_modules/stackbite/packaging/npm/bin/stackbite.js', shim);
  const npmCli = path.join(c.area, 'inert-npm.js');
  await fs.writeFile(npmCli, '// fixture npm boundary only');
  const sentinel = path.join(prefix, 'foreign-sentinel');
  await fs.writeFile(sentinel, 'preserve');
  return { packageRoot, nodeExecutable: process.execPath, npmCli, shim, sentinel };
}

function removePackage(pkg) {
  const child = new EventEmitter();
  process.nextTick(async () => {
    try {
      await fs.rm(pkg.packageRoot, { recursive: true });
      await fs.unlink(pkg.shim);
      child.emit('exit', 0, null);
    } catch (error) { child.emit('error', error); }
  });
  return child;
}

async function absentProduct(c) {
  // Independent physical oracle: all three gate roots, not journal/inventory.
  for (const location of [c.root, c.cache, c.environment.STACKBITE_STATE_DIR,
    path.join(c.environment.USERPROFILE, '.local/bin/.stackbite-update')]) {
    await assert.rejects(fs.lstat(location), { code: 'ENOENT' }, location);
  }
}

async function touchKernelGate(c) {
  const program = 'import os,sys\nfrom private_pty.self_update import _update_lock\nwith _update_lock(sys.argv[1]): pass\n';
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.STACKBITE_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      ['-B', '-c', program, c.root], { cwd: pythonOracle.root(), env: c.environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic += bytes; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(diagnostic)));
  });
}

for (const boundary of ['mkdir', 'open']) test(`ordinary uninstall before first preparation ${boundary} leaves zero download or residual`, async t => {
  const c = await owned(t), pkg = await globalPackage(c);
  const original = fs[boundary];
  const location = path.join(c.root, '.stackbite-update', ...(boundary === 'open' ? ['update.lock'] : []));
  let paused = false, removal;
  fs[boundary] = async function (selected, ...args) {
    if (!paused && selected === location) {
      paused = true;
      removal = await main(['uninstall'], settings(c, { ...pkg,
        downloadImpl: () => assert.fail('removal downloaded'), spawnImpl: () => removePackage(pkg) }));
      assert.deepEqual(removal, { code: 0, signal: null });
      await assert.rejects(fs.lstat(pkg.packageRoot), { code: 'ENOENT' });
    }
    return original.call(this, selected, ...args);
  };
  try {
    await assert.rejects(main(['setup'], settings(c, { ...pkg,
      downloadImpl: () => assert.fail('stale setup downloaded'),
      spawnImpl: () => assert.fail('stale setup launched') })), /ENOENT|registration changed/);
  } finally { fs[boundary] = original; }
  assert.equal(paused, true);
  await absentProduct(c);
  assert.equal(await fs.readFile(pkg.sentinel, 'utf8'), 'preserve');
});

test('real source publisher rejects missing registration before gates; Node finally settles its exact preparation', async t => {
  const c = await owned(t), pkg = await globalPackage(c), calls = [], stages = [];
  await assert.rejects(main(['setup'], settings(c, { ...pkg,
    async downloadImpl(spec, archive) { stages.push(path.dirname(archive)); await fs.writeFile(archive, c.value.bytes); },
    spawnImpl: actualEngine(c, calls, async () => {
      // The npm child boundary physically removes only this genuine package.
      await new Promise((resolve, reject) => { const child = removePackage(pkg); child.on('error', reject); child.on('exit', resolve); });
    }) })), /publication was refused/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], '--record-install');
  for (const stage of stages) await assert.rejects(fs.lstat(stage), { code: 'ENOENT' });
  await absentProduct(c);
  assert.equal(await fs.readFile(pkg.sentinel, 'utf8'), 'preserve');
});

for (const change of ['lock-byte', 'foreign-bytes', 'replacement-lock', 'replacement-package', 'new-lifetime', 'hardlink', 'control-redirect']) {
  test(`cancelled genuine npm preparation settles only exact owned controls (${change})`, async t => {
    const c = await owned(t), pkg = await globalPackage(c), file = path.join(c.root, '.stackbite-update/update.lock');
    let preserved;
    await assert.rejects(main(['setup'], settings(c, { ...pkg,
      async downloadImpl(spec, archive) {
        await fs.writeFile(archive, c.value.bytes);
        if (change === 'replacement-lock') {
          await fs.unlink(file); await fs.writeFile(file, '');
        } else if (change === 'hardlink') {
          await fs.unlink(file); await fs.link(pkg.sentinel, file);
        } else if (change === 'control-redirect') {
          const foreign = path.join(c.area, 'foreign');
          await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'update.lock'), 'foreign');
          await fs.unlink(file); await fs.rmdir(path.dirname(file));
          await fs.symlink(foreign, path.dirname(file), process.platform === 'win32' ? 'junction' : 'dir');
        } else if (change === 'new-lifetime') {
          preserved = JSON.stringify({ installation_id: 'e'.repeat(32), home: c.area, state: c.environment.STACKBITE_STATE_DIR });
          await fs.writeFile(path.join(c.root, 'default-install.json'), preserved);
        } else if (change === 'lock-byte') {
          const before = await fs.lstat(file, { bigint: true });
          await touchKernelGate(c);
          const after = await fs.lstat(file, { bigint: true });
          assert.equal(after.ino, before.ino);
          assert.equal(await fs.readFile(file, 'utf8'), process.platform === 'win32' ? '0' : '');
        } else await fs.writeFile(file, change === 'foreign-bytes' ? 'foreign' : '0');
        await new Promise((resolve, reject) => { const child = removePackage(pkg); child.on('error', reject); child.on('exit', resolve); });
        if (change === 'replacement-package') {
          await fs.mkdir(pkg.packageRoot, { recursive: true });
          await fs.writeFile(path.join(pkg.packageRoot, 'package.json'), '{"name":"stackbite"}');
          await fs.writeFile(path.join(pkg.packageRoot, 'new-owner'), 'preserve');
        }
      }, spawnImpl: () => assert.fail('stale registration launched') })), /ENOENT|registration changed|Installation changed|baseline file|link or non-directory/);
    if (change === 'lock-byte') await absentProduct(c);
    else {
      await fs.lstat(file);
      if (change === 'foreign-bytes') assert.equal(await fs.readFile(file, 'utf8'), 'foreign');
      if (change === 'new-lifetime') assert.equal(await fs.readFile(path.join(c.root, 'default-install.json'), 'utf8'), preserved);
      if (change === 'replacement-package') assert.equal(await fs.readFile(path.join(pkg.packageRoot, 'new-owner'), 'utf8'), 'preserve');
      if (change === 'hardlink') assert.equal(await fs.readFile(file, 'utf8'), 'preserve');
      if (change === 'control-redirect') {
        assert.equal(await fs.readFile(file, 'utf8'), 'foreign');
        assert.equal((await fs.lstat(path.dirname(file))).isSymbolicLink(), true);
      }
    }
    assert.equal(await fs.readFile(pkg.sentinel, 'utf8'), 'preserve');
  });
}

async function removeProduct(c) {
  const root = pythonOracle.root();
  const program = `import os,sys;sys.path.insert(0,${JSON.stringify(root)});`
    + 'from pathlib import Path;from private_pty import uninstall as u;from private_pty.uninstall_finalize import finalize;'
    + 'state=Path(os.environ["STACKBITE_STATE_DIR"]);journal=u.locations.install_root()/u.JOURNAL;'
    + 'record=u.plan_removal(state,remove_data=True,environment=os.environ);u.stop_owned=lambda *args:None;'
    + 'u.perform(u.parse([]),record,journal,os.environ);assert not journal.exists()';
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.STACKBITE_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      ['-B', '-c', program], { env: c.environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    child.stdout.on('data', bytes => { diagnostic += bytes; });
    child.stderr.on('data', bytes => { diagnostic += bytes; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Owned fixture removal failed: ${diagnostic}`)));
  });
}

test('accepted removal before first write makes no cache, download or engine launch', async t => {
  const c = await owned(t);
  await accepted(c);
  await assert.rejects(main(['setup'], settings(c, {
    downloadImpl: () => assert.fail('accepted removal downloaded'),
    spawnImpl: () => assert.fail('accepted removal launched') })), /removal is in progress/);
  await assert.rejects(fs.lstat(c.cache), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(c.root), ['.stackbite-uninstall.json']);
});

test('Windows fallback removal admission uses the locator root before any npm writes',
  { skip: process.platform !== 'win32' }, async t => {
  const c = await owned(t);
  delete c.environment.LOCALAPPDATA;
  c.root = path.join(c.environment.USERPROFILE, 'Stackbite');
  c.cache = path.join(c.environment.USERPROFILE, 'AppData/Local/Stackbite/cache');
  await accepted(c);
  const options = settings(c, { downloadImpl: () => assert.fail('accepted removal downloaded'),
    spawnImpl: () => assert.fail('accepted removal launched') });
  delete options.cache;
  await assert.rejects(main(['setup'], options), /removal is in progress/);
  await assert.rejects(fs.lstat(c.cache), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(c.root), ['.stackbite-uninstall.json']);
});

test('acceptance during download cleans the owned external stage without publishing cache', async t => {
  const c = await owned(t), stages = [];
  await assert.rejects(main(['setup'], settings(c, {
    async downloadImpl(spec, archive) {
      stages.push(path.dirname(archive));
      assert.ok(!archive.startsWith(c.cache + path.sep));
      await fs.writeFile(archive, c.value.bytes);
      await accepted(c);
    }, spawnImpl: () => assert.fail('accepted staging launched publication') })), /removal is in progress/);
  assert.equal(stages.length, 1);
  for (const stage of stages) await assert.rejects(fs.lstat(stage), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(c.cache), { code: 'ENOENT' });
});

test('removal accepted between JavaScript check and real engine publication wins the OS gate', async t => {
  const c = await owned(t), calls = [], stages = [];
  await assert.rejects(main(['setup'], settings(c, {
    async downloadImpl(spec, archive) { stages.push(path.dirname(archive)); await fs.writeFile(archive, c.value.bytes); },
    spawnImpl: actualEngine(c, calls, () => accepted(c)) })), /publication was refused/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-1), ['cache']);
  await assert.rejects(fs.lstat(c.cache), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(c.root, 'default-install.json')), { code: 'ENOENT' });
  for (const stage of stages) await assert.rejects(fs.lstat(stage), { code: 'ENOENT' });
});

test('normal npm setup uses the real record-install entry and preserves ID on cached startup', async t => {
  const c = await owned(t), calls = [];
  const options = settings(c, { async downloadImpl(spec, archive) { await fs.writeFile(archive, c.value.bytes); },
    spawnImpl: actualEngine(c, calls) });
  assert.deepEqual(await main(['setup'], options), { code: 0, signal: null });
  const locator = path.join(c.root, 'default-install.json');
  const first = JSON.parse(await fs.readFile(locator, 'utf8'));
  assert.match(first.installation_id, /^[a-f0-9]{32}$/);
  // The runtime is durable: it lives in the versioned app root, not the cache.
  assert.ok(first.home.startsWith(c.app + path.sep));
  assert.deepEqual(await main(['--status'], { ...options, downloadImpl: () => assert.fail('cached startup downloaded') }), { code: 0, signal: null });
  const second = JSON.parse(await fs.readFile(locator, 'utf8'));
  assert.equal(second.installation_id, first.installation_id);
  assert.equal(calls.filter(call => call.args[0] !== '--record-install').length, 1);
  assert.equal(calls.filter(call => call.args[0] === '--record-install').length, 1, 'cached normal start must not spawn another maintenance engine');
  assert.deepEqual(await fs.readdir(c.app), [path.basename(first.home)]);
  await assert.rejects(fs.lstat(c.cache), { code: 'ENOENT' });
});

for (const localAppData of [true, false]) {
  test(`Windows default cache crosses actual setup/publication, warm start and no-runtime cleanup (LOCALAPPDATA=${localAppData})`,
    { skip: process.platform !== 'win32' }, async t => {
    const c = await owned(t), calls = [], stages = [];
    if (!localAppData) {
      delete c.environment.LOCALAPPDATA;
      c.root = path.join(c.environment.USERPROFILE, 'Stackbite');
      c.cache = path.join(c.environment.USERPROFILE, 'AppData/Local/Stackbite/cache');
      c.app = path.join(c.root, 'app');
    }
    c.environment.HOME = path.join(c.area, 'foreign-home');
    await fs.mkdir(c.environment.HOME);
    await fs.writeFile(path.join(c.environment.HOME, 'sentinel'), 'foreign home');
    // Exercise main's default cache selection, never a test cache override.
    const options = settings(c, { async downloadImpl(spec, archive) {
      stages.push(path.dirname(archive));
      await fs.writeFile(archive, c.value.bytes);
    }, spawnImpl: actualEngine(c, calls) });
    delete options.cache;
    assert.deepEqual(await main(['setup'], options), { code: 0, signal: null });
    const file = path.join(c.root, 'default-install.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(path.dirname(saved.home), c.app);
    assert.match(saved.installation_id, /^[a-f0-9]{32}$/);
    await main(['--status'], { ...options, downloadImpl: () => assert.fail('warm cache downloaded') });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved);
    assert.equal(calls.filter(call => call.args[0] === '--record-install').length, 1);
    if (!localAppData) {
      // Older Python removal/publication used locator-root/cache. Discovery
      // must retain those known payloads alongside npm's established cache.
      await fs.cp(saved.home, path.join(c.root, 'cache', 'v1-' + 'b'.repeat(64)), { recursive: true });
    }
    await removeProduct(c);
    await assert.rejects(fs.lstat(c.cache), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(c.root), { code: 'ENOENT' });
    // A cancelled new setup has no runtime. Ordinary uninstall must remove its
    // exact preparation and npm registration without starting an engine.
    const prefix = path.join(c.area, 'prefix'), packageRoot = path.join(prefix, 'node_modules/stackbite');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), '{"name":"stackbite"}');
    const npmCli = path.join(c.area, 'inert-npm.js');
    await fs.writeFile(npmCli, `require('node:fs').rmSync(${JSON.stringify(packageRoot)}, {recursive:true});`);
    const cleanup = { ...options, packageRoot, nodeExecutable: process.execPath, npmCli };
    await assert.rejects(main(['setup'], { ...cleanup, downloadImpl: () => { throw Error('cancelled download'); } }), /cancelled download/);
    assert.deepEqual(await fs.readdir(c.root), ['.stackbite-update']);
    assert.deepEqual(await main(['uninstall'], { ...cleanup, spawnImpl: spawn,
      downloadImpl: () => assert.fail('no-runtime uninstall downloaded') }), { code: 0, signal: null });
    for (const location of [c.root, c.cache, packageRoot, ...stages]) await assert.rejects(fs.lstat(location), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(c.environment.HOME, 'sentinel'), 'utf8'), 'foreign home');
  });
}

test('normal global npm setup persists the validated raw descriptor; spoofed env supplies no authority', async t => {
  const c = await owned(t), calls = [];
  const prefix = path.join(c.area, 'prefix');
  const packageRoot = path.join(prefix, process.platform === 'win32' ? 'node_modules/stackbite' : 'lib/node_modules/stackbite');
  const tools = path.join(c.area, 'tools');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.mkdir(tools);
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'stackbite' }));
  const nodeExecutable = path.join(tools, 'node'), npmCli = path.join(tools, 'npm-cli.js');
  await fs.writeFile(nodeExecutable, 'inert node identity');
  await fs.writeFile(npmCli, 'inert CLI identity');
  const options = settings(c, { packageRoot, nodeExecutable, npmCli,
    async downloadImpl(spec, archive) { await fs.writeFile(archive, c.value.bytes); }, spawnImpl: actualEngine(c, calls) });
  await main(['setup'], options);
  const locator = JSON.parse(await fs.readFile(path.join(c.root, 'default-install.json'), 'utf8'));
  assert.deepEqual(locator.npm_registration, { root: packageRoot, prefix,
    node: await fs.realpath(nodeExecutable), cli: await fs.realpath(npmCli) });
  // Refresh a genuinely different global descriptor with a per-run state.
  // The real maintenance entry must preserve the established selection.
  const nextNode = path.join(tools, 'next-node');
  await fs.writeFile(nextNode, 'another inert node identity');
  await main(['--status'], { ...options, nodeExecutable: nextNode,
    environment: { ...c.environment, STACKBITE_STATE_DIR: path.join(c.area, 'temporary-state') } });
  const refreshed = JSON.parse(await fs.readFile(path.join(c.root, 'default-install.json'), 'utf8'));
  assert.deepEqual({ ...refreshed, npm_registration: locator.npm_registration }, locator);
  assert.equal(refreshed.npm_registration.node, await fs.realpath(nextNode));
  const other = await owned(t), otherCalls = [];
  other.environment.STACKBITE_NPM_REGISTRATION = JSON.stringify({ root: '/foreign', prefix: '/', node: '/foreign', cli: '/foreign' });
  await main(['setup'], settings(other, {
    async downloadImpl(spec, archive) { await fs.writeFile(archive, other.value.bytes); }, spawnImpl: actualEngine(other, otherCalls) }));
  const ordinary = JSON.parse(await fs.readFile(path.join(other.root, 'default-install.json'), 'utf8'));
  assert.equal(ordinary.npm_registration, undefined);
});

for (const kind of ['temporary-state', 'default-control', 'direct-home', 'cache-miss']) {
  test(`ordinary npm runtime preserves established selection (${kind})`, async t => {
    const c = await owned(t), calls = [];
    const options = settings(c, { async downloadImpl(spec, archive) { await fs.writeFile(archive, c.value.bytes); }, spawnImpl: actualEngine(c, calls) });
    await main(['setup'], options);
    const file = path.join(c.root, 'default-install.json');
    let prior = JSON.parse(await fs.readFile(file, 'utf8'));
    if (['direct-home', 'cache-miss'].includes(kind)) {
      const metadata = JSON.parse(await fs.readFile(path.join(prior.home, 'portable.json'), 'utf8'));
      const host = { win32: 'windows-x64', linux: 'linux-x86_64', darwin: 'macos-arm64' }[process.platform];
      const name = process.platform === 'win32' ? `${metadata.version}-${metadata.commit.slice(0, 12)}`
        : `stackbite-${metadata.version}-${host}-${metadata.commit.slice(0, 12)}`;
      assert.deepEqual(await launchNative('inert', ['--record-install', path.join(c.root, 'app', name), prior.state, prior.home, 'install'],
        c.environment, { spawnImpl: actualEngine(c, []) }), { code: 0, signal: null });
      prior = JSON.parse(await fs.readFile(file, 'utf8'));
    }
    const environment = { ...c.environment };
    if (kind === 'temporary-state') environment.STACKBITE_STATE_DIR = path.join(c.area, 'temporary-state');
    else if (kind !== 'cache-miss') delete environment.STACKBITE_STATE_DIR;
    const maintenanceBefore = calls.filter(call => call.args[0] === '--record-install').length;
    const next = fixture(process.platform, {}, { [process.platform === 'win32' ? 'install.ps1' : 'install.sh']: Buffer.from('# inert installer'),
      'runtime/next.txt': Buffer.from('separate pinned cache') });
    await main(['--status'], { ...options, environment, ...(kind === 'cache-miss' ? { manifest: next.manifest } : {}),
      async downloadImpl(spec, archive) { assert.equal(kind, 'cache-miss'); await fs.writeFile(archive, next.bytes); } });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), prior);
    assert.equal(calls.filter(call => call.args[0] === '--record-install').length - maintenanceBefore, kind === 'cache-miss' ? 1 : 0);
    assert.equal(calls.at(-1).environment.STACKBITE_STATE_DIR, environment.STACKBITE_STATE_DIR);
    if (kind === 'temporary-state') {
      await assert.rejects(fs.stat(environment.STACKBITE_STATE_DIR), { code: 'ENOENT' });
    }
  });
}

for (const replacement of [false, true]) {
  test(`firstever actual Node download cannot resurrect after full removal (replacement=${replacement})`, async t => {
    const c = await owned(t), calls = [], stages = [], preserved = {};
    const file = path.join(c.root, 'default-install.json');
    const initial = settings(c, { async downloadImpl(spec, archive) { await fs.writeFile(archive, c.value.bytes); }, spawnImpl: actualEngine(c, []) });
    await assert.rejects(main(['setup'], { ...initial,
      async downloadImpl(spec, archive) {
        stages.push(path.dirname(archive));
        await assert.rejects(fs.stat(file), { code: 'ENOENT' });
        await fs.writeFile(archive, c.value.bytes);
        await removeProduct(c);
        await assert.rejects(fs.stat(path.join(c.root, '.stackbite-update', 'update.lock')), { code: 'ENOENT' });
        await assert.rejects(fs.stat(c.root), { code: 'ENOENT' });
        if (replacement) {
          await main(['setup'], initial);
          preserved.locator = await fs.readFile(file);
          preserved.app = await fs.readdir(c.app);
        }
      }, spawnImpl: actualEngine(c, calls) }), /Installation changed while staging/);
    assert.equal(calls.length, 0);
    for (const stage of stages) await assert.rejects(fs.stat(stage), { code: 'ENOENT' });
    if (replacement) {
      assert.deepEqual(await fs.readFile(file), preserved.locator);
      assert.deepEqual(await fs.readdir(c.app), preserved.app);
    } else {
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
      await assert.rejects(fs.stat(c.cache), { code: 'ENOENT' });
    }
  });
}

test('firstever full removal after the final Node check is rejected by the real engine', async t => {
  const c = await owned(t), calls = [];
  await assert.rejects(main(['setup'], settings(c, {
    async downloadImpl(spec, archive) { await fs.writeFile(archive, c.value.bytes); },
    spawnImpl: actualEngine(c, calls, () => removeProduct(c)) })), /publication was refused/);
  assert.equal(calls.length, 1);
  await assert.rejects(fs.stat(path.join(c.root, 'default-install.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(c.cache), { code: 'ENOENT' });
});

test('concurrent firstever npm setup shares preparation until real kernel publication', async t => {
  const c = await owned(t), calls = [];
  let downloads = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const options = settings(c, {
    async downloadImpl(spec, archive) {
      await fs.writeFile(archive, c.value.bytes);
      await assert.rejects(fs.stat(path.join(c.root, 'default-install.json')), { code: 'ENOENT' });
      if (++downloads === 2) release();
      await barrier;
    }, spawnImpl: actualEngine(c, calls) });
  assert.deepEqual(await Promise.all([main(['setup'], options), main(['setup'], options)]),
    [{ code: 0, signal: null }, { code: 0, signal: null }]);
  const saved = JSON.parse(await fs.readFile(path.join(c.root, 'default-install.json'), 'utf8'));
  assert.match(saved.installation_id, /^[a-f0-9]{32}$/);
  assert.equal((await fs.readdir(c.app)).length, 1);
  await removeProduct(c);
  await assert.rejects(fs.stat(c.cache), { code: 'ENOENT' });
});

test('cancelled firstever Node download releases preparation for full removal', async t => {
  const c = await owned(t), stages = [];
  await assert.rejects(main(['setup'], settings(c, {
    async downloadImpl(spec, archive) { stages.push(path.dirname(archive)); throw new Error('cancelled download'); },
    spawnImpl: () => assert.fail('cancelled preparation launched') })), /cancelled download/);
  for (const stage of stages) await assert.rejects(fs.stat(stage), { code: 'ENOENT' });
  await removeProduct(c);
  await assert.rejects(fs.stat(path.join(c.root, '.stackbite-update')), { code: 'ENOENT' });
});

test('firstever preparation refuses a redirected install root and preserves its foreign files', async t => {
  const c = await owned(t), foreign = path.join(c.area, 'foreign');
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, 'sentinel'), 'foreign project');
  await fs.mkdir(path.dirname(c.root), { recursive: true });
  await fs.symlink(foreign, c.root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(main(['setup'], settings(c, {
    downloadImpl: () => assert.fail('redirected preparation downloaded'),
    spawnImpl: () => assert.fail('redirected preparation launched') })), /link or non-directory/);
  assert.deepEqual(await fs.readdir(foreign), ['sentinel']);
  assert.equal(await fs.readFile(path.join(foreign, 'sentinel'), 'utf8'), 'foreign project');
});

test('firstever preparation preserves a source repository before creating its control object', async t => {
  const c = await owned(t);
  await fs.mkdir(path.join(c.area, '.git'));
  await fs.writeFile(path.join(c.area, 'sentinel'), 'foreign source');
  await assert.rejects(main(['setup'], settings(c, {
    downloadImpl: () => assert.fail('source-root preparation downloaded'),
    spawnImpl: () => assert.fail('source-root preparation launched') })), /source repository/);
  await assert.rejects(fs.stat(c.root), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(c.area, 'sentinel'), 'utf8'), 'foreign source');
});

test('legacy nullable locator baseline crosses Node/Python file IDs before binding once', async t => {
  const c = await owned(t), calls = [];
  const options = settings(c, { async downloadImpl(spec, archive) { await fs.writeFile(archive, c.value.bytes); }, spawnImpl: actualEngine(c, calls) });
  await main(['setup'], options);
  const file = path.join(c.root, 'default-install.json'), legacy = JSON.parse(await fs.readFile(file, 'utf8'));
  delete legacy.installation_id;
  await fs.writeFile(file, JSON.stringify(legacy));
  await main(['setup'], options);
  assert.match(JSON.parse(await fs.readFile(file, 'utf8')).installation_id, /^[a-f0-9]{32}$/);
});

for (const legacy of [false, true]) test(`real engine rejects full-tail ABA after the final JavaScript check (legacy=${legacy})`, async t => {
  const c = await owned(t), calls = [];
  const options = settings(c, { async downloadImpl(spec, archive) { await fs.writeFile(archive, c.value.bytes); }, spawnImpl: actualEngine(c, []) });
  await main(['setup'], options);
  const file = path.join(c.root, 'default-install.json');
  if (legacy) {
    const value = JSON.parse(await fs.readFile(file, 'utf8')); delete value.installation_id;
    await fs.writeFile(file, JSON.stringify(value));
  }
  const next = fixture(process.platform, {}, { [process.platform === 'win32' ? 'install.ps1' : 'install.sh']: Buffer.from('# inert installer'),
    'runtime/next.txt': Buffer.from('separate pinned candidate') });
  await assert.rejects(main(['setup'], { ...options, manifest: next.manifest,
    async downloadImpl(spec, archive) { await fs.writeFile(archive, next.bytes); },
    spawnImpl: actualEngine(c, calls, () => removeProduct(c)) }), /publication was refused/);
  assert.equal(calls.length, 1);
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(c.cache), { code: 'ENOENT' });
});

for (const legacy of [false, true]) for (const replacement of [false, true]) {
  test(`old Node staging cannot adopt a fully removed or replaced lifetime (legacy=${legacy}, replacement=${replacement})`, async t => {
    const c = await owned(t), initialCalls = [];
    const initial = settings(c, { async downloadImpl(spec, archive) { await fs.writeFile(archive, c.value.bytes); }, spawnImpl: actualEngine(c, initialCalls) });
    await main(['setup'], initial);
    const locator = path.join(c.root, 'default-install.json');
    if (legacy) {
      const value = JSON.parse(await fs.readFile(locator, 'utf8'));
      delete value.installation_id;
      await fs.writeFile(locator, JSON.stringify(value));
    }
    const next = fixture(process.platform, {}, { [process.platform === 'win32' ? 'install.ps1' : 'install.sh']: Buffer.from('# inert installer'),
      'runtime/next.txt': Buffer.from('a separate immutable candidate, same product build') });
    const stages = [], calls = [], preserved = {};
    await assert.rejects(main(['setup'], { ...initial, manifest: next.manifest,
      async downloadImpl(spec, archive) {
        stages.push(path.dirname(archive));
        await fs.writeFile(archive, next.bytes);
        await removeProduct(c);
        if (replacement) {
          await main(['setup'], initial);
          preserved.locator = await fs.readFile(locator);
          const current = JSON.parse(preserved.locator.toString('utf8'));
          preserved.sentinel = path.join(current.home, 'new-lifetime-sentinel');
          await fs.writeFile(preserved.sentinel, 'new lifetime');
          preserved.app = await fs.readdir(c.app);
        }
      }, spawnImpl: actualEngine(c, calls) }), /Installation changed while staging/);
    assert.equal(calls.length, 0);
    for (const stage of stages) await assert.rejects(fs.lstat(stage), { code: 'ENOENT' });
    if (replacement) {
      assert.deepEqual(await fs.readFile(locator), preserved.locator);
      assert.equal(await fs.readFile(preserved.sentinel, 'utf8'), 'new lifetime');
      assert.deepEqual(await fs.readdir(c.app), preserved.app);
    } else {
      await assert.rejects(fs.lstat(locator), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(c.cache), { code: 'ENOENT' });
    }
  });
}
