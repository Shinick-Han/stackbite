'use strict';
// An installation that already selects this package's exact pinned release
// outside app/ (an explicit STACKBITE_HOME or the locator's home) runs in
// place: no download, no copy, and the locator keeps its selection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');

// Count archive reads before bootstrap/download bind hashFile.
const common = require('../lib/common');
const hashed = [];
const originalHash = common.hashFile;
common.hashFile = (file, ...rest) => { hashed.push(file); return originalHash(file, ...rest); };
const { main, releaseSpec, ensureBinary } = require('../lib/bootstrap');
const { download } = require('../lib/download');
const { fixture, publishFixture } = require('./fixtures');

const platform = process.platform;
const ID = 'c'.repeat(32);

async function area(t, leaves = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sb68-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const environment = {};
  for (const [key, leaf] of Object.entries({ HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local',
    XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'states', XDG_CACHE_HOME: 'cache', ...leaves })) environment[key] = path.join(directory, leaf);
  const root = platform === 'win32' ? path.join(environment.LOCALAPPDATA, 'Stackbite') : path.join(environment.XDG_DATA_HOME, 'stackbite');
  return { directory, environment, root, app: path.join(root, 'app') };
}
// A release image unpacked at an installer-chosen home.
async function installImage(value, home) {
  for (const [name, bytes] of Object.entries(value.files)) {
    await fs.mkdir(path.dirname(path.join(home, name)), { recursive: true });
    await fs.writeFile(path.join(home, name), bytes, { mode: name === value.image ? 0o755 : 0o644 });
  }
  return home;
}
async function writeLocator(root, home, state, extra = {}) {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'default-install.json');
  await fs.writeFile(file, JSON.stringify({ home, state, installation_id: ID, ...extra }));
  return file;
}
// Launch double: maintenance (--record-install) and launches are counted apart.
function engine(counter) {
  return (executable, argv, config) => {
    const child = new EventEmitter();
    if (argv[0] === '--record-install') counter.maintenance.push({ executable, argv, home: config.env.STACKBITE_HOME });
    else counter.launches.push({ executable, argv, config });
    process.nextTick(() => child.emit('exit', 0, null));
    return child;
  };
}
function options(c, value, counter, extra = {}) {
  return { manifest: value.manifest, platform, arch: 'x64', environment: c.environment, progress: () => {},
    stdout: { write: () => {} }, stderr: { write: () => {} },
    downloadImpl: async (spec, archive) => { counter.downloads++; await fs.writeFile(archive, value.bytes, { flag: 'wx' }); },
    spawnImpl: engine(counter), ...extra };
}
const counters = () => ({ downloads: 0, maintenance: [], launches: [] });
const executableName = platform === 'win32' ? 'stackbite.exe' : 'stackbite';

test('locator-selected custom home of the exact pin runs in place on cold and warm entries', async t => {
  const c = await area(t), value = fixture(platform), counter = counters();
  const home = await installImage(value, path.join(c.directory, 'portable', 'stackbite'));
  const locator = await writeLocator(c.root, home, path.join(c.directory, 'state'));
  const before = await fs.readFile(locator);
  for (let run = 0; run < 3; run++) {
    assert.deepEqual(await main(['--status', 'two words'], options(c, value, counter)), { code: 0, signal: null });
  }
  assert.equal(counter.downloads, 0);
  assert.deepEqual(counter.maintenance, []);
  assert.equal(counter.launches.length, 3);
  for (const launch of counter.launches) {
    assert.equal(launch.executable, path.join(home, executableName));
    assert.deepEqual(launch.argv, ['--status', 'two words']);
    assert.equal(launch.config.env.STACKBITE_HOME, home);
    assert.equal(launch.config.cwd, undefined);
    assert.equal(launch.config.shell, false);
  }
  // setup and setup --check report the same selected image ready.
  for (const argv of [['setup'], ['setup', '--check']]) {
    assert.deepEqual(await main(argv, options(c, value, counter)), { code: 0, signal: null });
  }
  assert.equal(counter.downloads, 0);
  assert.deepEqual(await fs.readFile(locator), before);
  await assert.rejects(fs.lstat(c.app), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(c.environment.XDG_CACHE_HOME), { code: 'ENOENT' });
});

test('cold --help/--version still answer from the pin without starting the selected image', async t => {
  const c = await area(t), value = fixture(platform), counter = counters(), printed = [];
  const home = await installImage(value, path.join(c.directory, 'portable'));
  await writeLocator(c.root, home, path.join(c.directory, 'state'));
  await main(['--version'], options(c, value, counter, { stdout: { write: text => printed.push(text) } }));
  assert.equal(printed.join(''), `Stackbite ${value.manifest.version} (${value.manifest.commit})\n`);
  assert.equal(counter.launches.length + counter.maintenance.length + counter.downloads, 0);
});

test('one shared explicit runtime serves two host environment variants without download or copy', async t => {
  const c = await area(t), value = fixture(platform), counter = counters();
  const shared = await installImage(value, path.join(c.directory, 'nfs', 'stackbite-runtime'));
  // The locator names an image that is not on this host; the explicit binding wins.
  const locator = await writeLocator(c.root, path.join(c.directory, 'gone'), path.join(c.directory, 'state'));
  const before = await fs.readFile(locator);
  const hosts = [
    { ...c.environment, STACKBITE_HOME: shared, XDG_CACHE_HOME: path.join(c.directory, 'hostA-cache'), PATH: 'hostA' },
    { ...c.environment, STACKBITE_HOME: shared, XDG_CACHE_HOME: path.join(c.directory, 'hostB-cache'), PATH: 'hostB' },
  ];
  for (let run = 0; run < 4; run++) {
    const environment = hosts[run % 2];
    await main(['room', 'list'], options(c, value, counter, { environment, cache: undefined }));
  }
  assert.equal(counter.downloads, 0);
  assert.deepEqual(counter.maintenance, []);
  assert.deepEqual(counter.launches.map(launch => [launch.executable, launch.config.env.PATH]), [
    [path.join(shared, executableName), 'hostA'], [path.join(shared, executableName), 'hostB'],
    [path.join(shared, executableName), 'hostA'], [path.join(shared, executableName), 'hostB']]);
  assert.deepEqual(await fs.readFile(locator), before);
  await assert.rejects(fs.lstat(c.app), { code: 'ENOENT' });
});

test('another version, platform or pin is never executed; the pinned release is installed instead', async t => {
  for (const changes of [{ version: '0.0.1' }, { platform: 'other-platform' }, { commit: 'b'.repeat(40) }]) {
    const c = await area(t), value = fixture(platform), other = fixture(platform, changes), counter = counters();
    const explicit = await installImage(other, path.join(c.directory, 'explicit'));
    const selected = await installImage(other, path.join(c.directory, 'selected'));
    await writeLocator(c.root, selected, path.join(c.directory, 'state'));
    const publications = [];
    const publishImpl = async (payload, target, spec, settings) => {
      publications.push({ payload, target, existing: settings.existing });
      return publishFixture(payload, target, spec, settings);
    };
    await main(['--status'], options(c, value, counter, { publishImpl,
      environment: { ...c.environment, STACKBITE_HOME: explicit } }));
    assert.equal(counter.downloads, 1, JSON.stringify(changes));
    assert.equal(counter.launches.length, 1);
    const executable = counter.launches[0].executable;
    assert.ok(executable.startsWith(c.app + path.sep), executable);
    assert.ok(![explicit, selected].some(home => executable.startsWith(home)));
    assert.deepEqual(publications.map(item => [item.target.startsWith(c.app + path.sep), item.existing]), [[true, false]]);
  }
});

test('a damaged image of this release fails before exec and is not replaced by a download', async t => {
  for (const binding of ['locator', 'explicit']) {
    const c = await area(t), value = fixture(platform), counter = counters();
    const home = await installImage(value, path.join(c.directory, 'portable'));
    await fs.writeFile(path.join(home, 'runtime', 'owned.txt'), 'changed');
    await writeLocator(c.root, binding === 'locator' ? home : path.join(c.directory, 'gone'), path.join(c.directory, 'state'));
    const environment = binding === 'explicit' ? { ...c.environment, STACKBITE_HOME: home } : c.environment;
    await assert.rejects(main(['--status'], options(c, value, counter, { environment })), /SHA-256 mismatch: runtime\/owned.txt/);
    assert.equal(counter.downloads + counter.launches.length + counter.maintenance.length, 0);
    await assert.rejects(fs.lstat(c.app), { code: 'ENOENT' });
  }
});

test('a removal in progress for the installation cannot be resurrected through the selected image', async t => {
  const c = await area(t), value = fixture(platform), counter = counters();
  const home = await installImage(value, path.join(c.directory, 'portable'));
  await writeLocator(c.root, home, path.join(c.directory, 'state'));
  await fs.writeFile(path.join(c.root, '.stackbite-uninstall.json'), JSON.stringify({ schema: 'stackbite.uninstall.v1',
    phase: 'stopped', install_identity: { root: c.root, incarnation: ID } }));
  await assert.rejects(main(['--status'], options(c, value, counter)), /removal is in progress/);
  assert.equal(counter.downloads + counter.launches.length + counter.maintenance.length, 0);
});

test('an explicit XDG data root switch without a binding stays a distinct installation', async t => {
  // XDG_DATA_HOME selects the POSIX installation root; a glibc report selects Linux here.
  const c = await area(t), value = fixture('linux'), counter = counters();
  const root = path.join(c.environment.XDG_DATA_HOME, 'stackbite');
  const home = await installImage(value, path.join(c.directory, 'portable'));
  const locator = await writeLocator(root, home, path.join(c.directory, 'state'));
  const before = await fs.readFile(locator);
  const linux = { platform: 'linux', glibcVersionRuntime: '2.28', publishImpl: publishFixture };
  const switched = { ...c.environment, XDG_DATA_HOME: path.join(c.directory, 'other-data') };
  await main(['--status'], options(c, value, counter, { ...linux, environment: switched }));
  assert.equal(counter.downloads, 1);
  assert.ok(counter.launches[0].executable.startsWith(path.join(switched.XDG_DATA_HOME, 'stackbite', 'app') + path.sep));
  // The unswitched root still runs its own selection in place.
  await main(['--status'], options(c, value, counter, linux));
  assert.equal(counter.downloads, 1);
  assert.equal(counter.launches[1].executable, path.join(home, 'stackbite'));
  assert.deepEqual(await fs.readFile(locator), before);
});

test('the real download path hashes the archive once; an injected transport is still rechecked', async t => {
  const c = await area(t), value = fixture(platform), spec = releaseSpec(value.manifest, platform, 'x64');
  const runtime = path.join(c.directory, 'runtime'), cache = path.join(c.directory, 'cache');
  const original = https.get;
  t.after(() => { https.get = original; });
  let requests = 0;
  https.get = (url, settings, respond) => {
    requests++;
    const response = Readable.from([value.bytes]);
    Object.assign(response, { statusCode: 200, headers: { 'content-length': String(value.bytes.length) } });
    process.nextTick(() => respond(response));
    return new EventEmitter();
  };
  const archives = () => hashed.filter(file => path.basename(file) === spec.asset).length;
  const base = archives();
  const first = await ensureBinary(spec, { cache, runtime, environment: c.environment, publishImpl: publishFixture, downloadImpl: download });
  assert.equal(requests, 1);
  assert.equal(archives() - base, 1);
  // Warm entries download and hash no archive.
  for (let run = 0; run < 2; run++) {
    assert.deepEqual(await ensureBinary(spec, { cache, runtime, environment: c.environment, publishImpl: publishFixture,
      downloadImpl: () => assert.fail('warm entry downloaded') }), first);
  }
  assert.equal(archives() - base, 1);
  // A transport that is not download() is verified again before extraction.
  const injected = await area(t);
  await assert.rejects(ensureBinary(spec, { cache: path.join(injected.directory, 'cache'), runtime: path.join(injected.directory, 'runtime'),
    environment: injected.environment, publishImpl: publishFixture,
    downloadImpl: async (_, archive) => fs.writeFile(archive, Buffer.concat([value.bytes.subarray(1), Buffer.from('x')])),
    extractImpl: () => assert.fail('unverified archive extracted') }), /Pinned archive SHA-256 or size mismatch/);
  assert.equal(archives() - base, 2);
});

// The real Python --record-install keeps the locator's home and refreshes only
// a changed npm registration; a matching registration starts no maintenance.
test('npm registration refresh still works through the selected image without moving its home', async t => {
  const python = process.env.STACKBITE_TEST_PYTHON || (platform === 'win32' ? 'python' : 'python3');
  const c = await area(t, { STACKBITE_STATE_DIR: 'state', APPDATA: 'config' });
  for (const [key, value] of Object.entries(process.env)) {
    if (['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT'].includes(key.toUpperCase())) c.environment[key] = value;
  }
  c.environment.PYTHONDONTWRITEBYTECODE = '1';
  const source = path.resolve(__dirname, '../../..');
  const run = (args, env) => new Promise((resolve, reject) => {
    const child = spawn(python, ['-B', ...args], { cwd: source, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic += bytes; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(diagnostic)));
  });
  await run(['-c', 'import os; from private_pty.private_state import ensure_directory; ensure_directory(os.environ["STACKBITE_STATE_DIR"])'], c.environment);
  const value = fixture(platform), counter = counters();
  const home = await installImage(value, path.join(c.directory, 'portable', 'stackbite'));
  // Establish the locator through the real producer, selecting the custom home.
  await run(['stackbite.py', '--record-install', home, c.environment.STACKBITE_STATE_DIR], c.environment);
  const file = path.join(c.root, 'default-install.json');
  const established = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(established.home, home);
  const prefix = path.join(c.directory, 'prefix');
  const packageRoot = path.join(prefix, platform === 'win32' ? 'node_modules/stackbite' : 'lib/node_modules/stackbite');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'stackbite' }));
  const tools = path.join(c.directory, 'tools');
  await fs.mkdir(tools);
  const nodeExecutable = path.join(tools, 'node'), npmCli = path.join(tools, 'npm-cli.js');
  await fs.writeFile(nodeExecutable, 'inert node identity');
  await fs.writeFile(npmCli, 'inert CLI identity');
  // Maintenance runs the source engine, started as the selected image.
  const maintenance = (executable, argv, config) => {
    if (argv[0] !== '--record-install') return engine(counter)(executable, argv, config);
    counter.maintenance.push({ executable, argv });
    assert.equal(executable, path.join(home, executableName));
    assert.equal(config.env.STACKBITE_HOME, home);
    return spawn(python, ['-B', 'stackbite.py', ...argv], { ...config, cwd: source, stdio: ['ignore', 'ignore', 'inherit'] });
  };
  const settings = options(c, value, counter, { packageRoot, nodeExecutable, npmCli, spawnImpl: maintenance });
  await main(['--status'], settings);
  assert.equal(counter.maintenance.length, 1);
  const refreshed = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual({ ...refreshed, npm_registration: undefined }, { ...established, npm_registration: undefined });
  assert.deepEqual(refreshed.npm_registration, { root: packageRoot, prefix,
    node: await fs.realpath(nodeExecutable), cli: await fs.realpath(npmCli) });
  // Unchanged registration: warm entry, no maintenance and no rewrite.
  const bytes = await fs.readFile(file);
  await main(['--status'], settings);
  assert.equal(counter.maintenance.length, 1);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal(counter.downloads, 0);
  assert.equal(counter.launches.length, 2);
  assert.ok(counter.launches.every(launch => launch.executable === path.join(home, executableName)));
  await assert.rejects(fs.lstat(c.app), { code: 'ENOENT' });
});

// Another archive of the same release keeps a consistent manifest of its own
// and gets a pin-qualified sibling (wave65-cache-quota); these are damage.
test('a damaged pinned document of this release refuses before download or exec', async t => {
  const damages = {
    'manifest-truncated': async home => {
      const file = path.join(home, 'SHA256SUMS.json');
      await fs.writeFile(file, (await fs.readFile(file)).subarray(0, 20));
    },
    'manifest-digest': async home => {
      const file = path.join(home, 'SHA256SUMS.json'), hashes = JSON.parse(await fs.readFile(file, 'utf8'));
      await fs.writeFile(file, JSON.stringify({ ...hashes, 'portable.json': 'f'.repeat(64) }));
    },
    metadata: async home => {
      const file = path.join(home, 'portable.json');
      await fs.writeFile(file, JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8')), null, 1));
    },
  };
  for (const [kind, damage] of Object.entries(damages)) {
    for (const binding of ['locator', 'explicit']) {
      const c = await area(t), value = fixture(platform), counter = counters();
      const home = await installImage(value, path.join(c.directory, 'portable'));
      await damage(home);
      await writeLocator(c.root, binding === 'locator' ? home : path.join(c.directory, 'gone'), path.join(c.directory, 'state'));
      const environment = binding === 'explicit' ? { ...c.environment, STACKBITE_HOME: home } : c.environment;
      await assert.rejects(main(['--status'], options(c, value, counter, { environment })),
        /Pinned release manifest or metadata SHA-256 mismatch/, `${kind} ${binding}`);
      assert.equal(counter.downloads + counter.launches.length + counter.maintenance.length, 0);
      await assert.rejects(fs.lstat(c.app), { code: 'ENOENT' });
    }
  }
});

// A previous-layout cache image recorded by another host: <cache>/stackbite/v1-<64 hex>.
const FORMER = path.join('hostA-cache', 'stackbite', 'v1-' + 'd'.repeat(64));
const MATRIX = [['win32', 'x64', {}], ['linux', 'x64', { glibcVersionRuntime: '2.28' }], ['darwin', 'arm64', {}]];
function targetName(value, target) {
  return target === 'win32' ? `${value.manifest.version}-${value.manifest.commit.slice(0, 12)}` : value.root;
}
async function snapshot(directory) {
  const files = {};
  for (const name of await fs.readdir(directory, { recursive: true })) {
    const file = path.join(directory, name);
    if ((await fs.lstat(file)).isFile()) files[name] = (await fs.readFile(file)).toString('base64');
  }
  return files;
}

// Source-level emulation of each host's paths and native headers; on a host
// other than its own this is not native proof for that platform.
for (const [target, arch, runtime] of MATRIX) {
  for (const published of [false, true]) {
    test(`${target}-${arch} former-host cache selection is adopted once, never run in place (target ${published ? 'present' : 'missing'})`, async t => {
      const c = await area(t), value = fixture(target), counter = counters();
      const root = target === 'win32' ? path.join(c.environment.LOCALAPPDATA, 'Stackbite') : path.join(c.environment.XDG_DATA_HOME, 'stackbite');
      const app = path.join(root, 'app'), durable = path.join(app, targetName(value, target));
      const former = await installImage(value, path.join(c.directory, FORMER));
      const locator = await writeLocator(root, former, path.join(c.directory, 'state'));
      if (published) await installImage(value, durable);
      // The engine double copies a missing target and moves the selection, as publish_runtime_cache does.
      const spawnImpl = (executable, argv, config) => {
        if (argv[0] !== '--record-install') return engine(counter)(executable, argv, config);
        counter.maintenance.push({ executable, argv });
        const child = new EventEmitter();
        (async () => {
          if (!await fs.lstat(argv[1]).catch(() => null)) await fs.cp(argv[3], argv[1], { recursive: true });
          const saved = JSON.parse(await fs.readFile(locator, 'utf8'));
          await fs.writeFile(locator, JSON.stringify({ ...saved, home: argv[1] }));
        })().then(() => child.emit('exit', 0, null), error => child.emit('error', error));
        return child;
      };
      const settings = options(c, value, counter, { platform: target, arch, ...runtime, spawnImpl });
      const before = await snapshot(former);
      await main(['--status'], settings);
      assert.equal(counter.downloads, 0);
      assert.deepEqual(counter.maintenance.map(item => item.argv), [['--record-install', durable, '-', published ? durable : former, 'cache']]);
      assert.deepEqual(await snapshot(former), before);
      // Warm entries after adoption: no download, copy or maintenance, even without the former cache.
      await main(['--status'], settings);
      await fs.rm(path.join(c.directory, 'hostA-cache'), { recursive: true });
      await main(['--status'], settings);
      assert.equal(counter.downloads, 0);
      assert.equal(counter.maintenance.length, 1);
      const image = path.join(durable, target === 'win32' ? 'stackbite.exe' : 'stackbite');
      assert.deepEqual(counter.launches.map(launch => [launch.executable, launch.config.env.STACKBITE_HOME]), Array(3).fill([image, durable]));
      assert.deepEqual(await fs.readdir(app), [path.basename(durable)]);
    });
  }
}

// The real Python publisher (publish_runtime_cache/record_install) with inert payloads.
const python = process.env.STACKBITE_TEST_PYTHON || (platform === 'win32' ? 'python' : 'python3');
const sourceRoot = path.resolve(__dirname, '../../..');
function runPython(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-B', ...args], { cwd: sourceRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic += bytes; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(diagnostic)));
  });
}
async function pythonArea(t) {
  const c = await area(t, { STACKBITE_STATE_DIR: 'state', APPDATA: 'config', XDG_CACHE_HOME: 'hostB-cache' });
  for (const [key, value] of Object.entries(process.env)) {
    if (['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT'].includes(key.toUpperCase())) c.environment[key] = value;
  }
  c.environment.PYTHONDONTWRITEBYTECODE = '1';
  await runPython(['-c', 'import os; from private_pty.private_state import ensure_directory; ensure_directory(os.environ["STACKBITE_STATE_DIR"])'], c.environment);
  return c;
}
// Maintenance runs the source engine; launches stay inert.
function pythonEngine(counter) {
  return (executable, argv, config) => {
    if (argv[0] !== '--record-install') return engine(counter)(executable, argv, config);
    counter.maintenance.push({ executable, argv });
    return spawn(python, ['-B', 'stackbite.py', ...argv], { ...config, cwd: sourceRoot, stdio: ['ignore', 'ignore', 'inherit'] });
  };
}
const installer = { [platform === 'win32' ? 'install.ps1' : 'install.sh']: Buffer.from('# inert installer') };
// A same-state locator from the real producer, plus a field it does not know.
async function formerLocator(c, home) {
  await runPython(['stackbite.py', '--record-install', home, c.environment.STACKBITE_STATE_DIR], c.environment);
  const file = path.join(c.root, 'default-install.json');
  const saved = { ...JSON.parse(await fs.readFile(file, 'utf8')), unknown_field: { kept: true } };
  await fs.writeFile(file, JSON.stringify(saved));
  return { file, saved };
}

for (const published of [false, true]) {
  test(`real publisher moves a former-host cache selection to the durable image (target ${published ? 'present' : 'missing'})`, async t => {
    const c = await pythonArea(t), value = fixture(platform, {}, installer), counter = counters();
    const durable = path.join(c.app, targetName(value, platform));
    const former = await installImage(value, path.join(c.directory, FORMER));
    const { file, saved } = await formerLocator(c, former);
    assert.equal(saved.home, former);
    assert.equal(saved.state, c.environment.STACKBITE_STATE_DIR);
    if (published) await installImage(value, durable);
    const before = await snapshot(former);
    const settings = options(c, value, counter, { spawnImpl: pythonEngine(counter) });
    await main(['--status'], settings);
    assert.equal(counter.downloads, 0);
    assert.deepEqual(counter.maintenance.map(item => item.argv), [['--record-install', durable, '-', published ? durable : former, 'cache']]);
    const adopted = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(adopted.home, durable);
    assert.deepEqual({ ...adopted, home: undefined }, { ...saved, home: undefined });
    assert.deepEqual(await snapshot(former), before);
    assert.deepEqual(await fs.readdir(c.app), [path.basename(durable)]);
    // Warm entries: no download, copy, maintenance or locator rewrite; deleting
    // the former cache cannot break the durable selection.
    const bytes = await fs.readFile(file);
    await main(['--status'], settings);
    await fs.rm(path.join(c.directory, 'hostA-cache'), { recursive: true });
    await main(['--status'], settings);
    assert.equal(counter.downloads, 0);
    assert.equal(counter.maintenance.length, 1);
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.deepEqual(counter.launches.map(launch => [launch.executable, launch.config.env.STACKBITE_HOME]),
      Array(3).fill([path.join(durable, executableName), durable]));
  });
}

// A per-run STACKBITE_STATE_DIR other than the locator's state classifies the
// former cache the same way: it is never run in place and, with no durable
// target, is copied once. Only a launch under the locator's own state moves the
// default selection; the override never changes the default locator. The
// engine consumes a legacy HELM_STATE_DIR only when STACKBITE_STATE_DIR is
// absent, so the alias overrides the same way and a present canonical wins.
const overrides = {
  canonical: (environment, run) => ({ ...environment, STACKBITE_STATE_DIR: run }),
  alias: ({ STACKBITE_STATE_DIR, ...environment }, run) => ({ ...environment, HELM_STATE_DIR: run }),
  both: (environment, run) => ({ ...environment, STACKBITE_STATE_DIR: run, HELM_STATE_DIR: environment.STACKBITE_STATE_DIR }),
};
for (const [variant, select] of Object.entries(overrides)) for (const published of [false, true]) {
  test(`a per-run ${variant} state override never runs a former-host cache in place (target ${published ? 'present' : 'missing'})`, async t => {
    const c = await pythonArea(t), value = fixture(platform, {}, installer), counter = counters();
    const durable = path.join(c.app, targetName(value, platform)), image = path.join(durable, executableName);
    const former = await installImage(value, path.join(c.directory, FORMER));
    const { file, saved } = await formerLocator(c, former);
    if (published) await installImage(value, durable);
    const run = path.join(c.directory, 'run-state'), override = select(c.environment, run);
    await runPython(['-c', 'import os; from private_pty.private_state import ensure_directory; ensure_directory(os.environ["STACKBITE_STATE_DIR"])'], { ...c.environment, STACKBITE_STATE_DIR: run });
    const before = await snapshot(former), locatorBytes = await fs.readFile(file);
    const overridden = options(c, value, counter, { environment: override, spawnImpl: pythonEngine(counter) });
    for (let run = 0; run < 3; run++) await main(['--status'], overridden);
    assert.equal(counter.downloads, 0);
    assert.deepEqual(counter.maintenance.map(item => item.argv), published ? [] : [['--record-install', durable, '-', former, 'cache']]);
    assert.deepEqual(await fs.readFile(file), locatorBytes);
    assert.deepEqual(await snapshot(former), before);
    assert.deepEqual(await fs.readdir(c.app), [path.basename(durable)]);
    assert.deepEqual(counter.launches.map(launch => [launch.executable, launch.config.env.STACKBITE_HOME]), Array(3).fill([image, durable]));
    // A later launch under the locator's own state moves the default selection once.
    const normal = options(c, value, counter, { spawnImpl: pythonEngine(counter) });
    await main(['--status'], normal);
    const maintained = counter.maintenance.length;
    assert.deepEqual(counter.maintenance.at(-1).argv, ['--record-install', durable, '-', durable, 'cache']);
    const adopted = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(adopted, { ...saved, home: durable });
    const bytes = await fs.readFile(file);
    await main(['--status'], normal);
    await main(['--status'], overridden);
    assert.equal(counter.downloads, 0);
    assert.equal(counter.maintenance.length, maintained);
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.deepEqual(await snapshot(former), before);
    assert.ok(counter.launches.every(launch => launch.executable === image));
  });
}

// An empty STACKBITE_STATE_DIR still wins over the alias: the engine selects
// the locator's own state, so the default selection moves once.
test('an empty canonical state beside a legacy alias moves the default selection once', async t => {
  const c = await pythonArea(t), value = fixture(platform, {}, installer), counter = counters();
  const durable = path.join(c.app, targetName(value, platform)), image = path.join(durable, executableName);
  const former = await installImage(value, path.join(c.directory, FORMER));
  const { file, saved } = await formerLocator(c, former);
  await installImage(value, durable);
  const run = path.join(c.directory, 'run-state');
  await runPython(['-c', 'import os; from private_pty.private_state import ensure_directory; ensure_directory(os.environ["STACKBITE_STATE_DIR"])'], { ...c.environment, STACKBITE_STATE_DIR: run });
  const settings = options(c, value, counter, { environment: { ...c.environment, STACKBITE_STATE_DIR: '', HELM_STATE_DIR: run },
    spawnImpl: pythonEngine(counter) });
  for (let entry = 0; entry < 3; entry++) await main(['--status'], settings);
  assert.equal(counter.downloads, 0);
  assert.deepEqual(counter.maintenance.map(item => item.argv), [['--record-install', durable, '-', durable, 'cache']]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { ...saved, home: durable });
  assert.deepEqual(counter.launches.map(launch => [launch.executable, launch.config.env.STACKBITE_HOME]), Array(3).fill([image, durable]));
});

test('a missing or mismatched former cache image never fabricates a migration', async t => {
  // An explicit null platform is not an omitted one: Python defaults only a
  // missing key, so the current durable image stays selected without maintenance.
  for (const kind of ['missing', 'other-version', 'other-commit', 'null-platform']) {
    const c = await pythonArea(t), value = fixture(platform, {}, installer), counter = counters();
    const changes = { 'other-version': { version: '0.0.1' }, 'other-commit': { commit: 'b'.repeat(40) },
      'null-platform': { platform: null } }[kind] || {};
    const former = await installImage(fixture(platform, changes, installer), path.join(c.directory, FORMER));
    const { file, saved } = await formerLocator(c, former);
    if (kind === 'missing') await fs.rm(former, { recursive: true });
    const published = kind === 'null-platform';
    const durable = path.join(c.app, targetName(value, platform));
    if (published) await installImage(value, durable);
    const settings = options(c, value, counter, { spawnImpl: pythonEngine(counter) });
    await main(['--status'], settings);
    await main(['--status'], settings);
    assert.equal(counter.downloads, published ? 0 : 1, kind);
    assert.equal(counter.maintenance.length, published ? 0 : 1, kind);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved, kind);
    assert.ok(counter.launches.every(launch => launch.executable === path.join(durable, executableName)), kind);
  }
});
