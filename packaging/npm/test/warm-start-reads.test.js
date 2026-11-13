'use strict';
// A warm start reads the installation locator and resolves the runtime root
// once per decision, while still hashing every pinned member of the image it
// runs: no download, no publisher child and no damaged image is accepted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

// Count reads before bootstrap binds the helpers.
const common = require('../lib/common');
const reads = [], hashed = [];
const originalRead = common.readSmall, originalHash = common.hashFile;
common.readSmall = (file, ...rest) => { reads.push(path.resolve(file)); return originalRead(file, ...rest); };
common.hashFile = (file, ...rest) => { hashed.push(path.resolve(file)); return originalHash(file, ...rest); };
const { main } = require('../lib/bootstrap');
const { fixture, publishFixture } = require('./fixtures');

const platform = process.platform;
const ID = 'd'.repeat(32);

async function area(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sbws-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const environment = {};
  for (const [key, leaf] of Object.entries({ HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local',
    XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'states', XDG_CACHE_HOME: 'cache' })) environment[key] = path.join(directory, leaf);
  const root = platform === 'win32' ? path.join(environment.LOCALAPPDATA, 'Stackbite') : path.join(environment.XDG_DATA_HOME, 'stackbite');
  return { directory, environment, root, app: path.join(root, 'app') };
}
async function installImage(value, home) {
  for (const [name, bytes] of Object.entries(value.files)) {
    await fs.mkdir(path.dirname(path.join(home, name)), { recursive: true });
    await fs.writeFile(path.join(home, name), bytes, { mode: name === value.image ? 0o755 : 0o644 });
  }
  return home;
}
async function writeLocator(root, home, state) {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'default-install.json');
  await fs.writeFile(file, JSON.stringify({ home, state, installation_id: ID }));
  return file;
}
function options(c, value, counter, extra = {}) {
  return { manifest: value.manifest, platform, arch: 'x64', environment: c.environment, progress: () => {},
    stdout: { write: () => {} }, stderr: { write: () => {} },
    downloadImpl: async (spec, archive) => { counter.downloads++; await fs.writeFile(archive, value.bytes, { flag: 'wx' }); },
    spawnImpl: (executable, argv) => {
      const child = new EventEmitter();
      (argv[0] === '--record-install' ? counter.maintenance : counter.launches).push({ executable, argv });
      process.nextTick(() => child.emit('exit', 0, null));
      return child;
    }, ...extra };
}
// Pinned members of a fixture image other than the checksum documents themselves.
const pinned = value => Object.keys(value.files).filter(name => !['SHA256SUMS.json', 'SHA256SUMS'].includes(name));
async function warmRun(c, value, counter) {
  reads.length = 0; hashed.length = 0;
  assert.deepEqual(await main(['--status'], options(c, value, counter)), { code: 0, signal: null });
  return { reads: [...reads], hashed: [...hashed] };
}

test('a warm app/ runtime start shares one locator read per decision and still hashes every pinned member', async t => {
  const c = await area(t), value = fixture(platform), counter = { downloads: 0, maintenance: [], launches: [] };
  await main(['--status'], options(c, value, counter, { publishImpl: publishFixture }));
  assert.equal(counter.downloads, 1);
  const [name] = await fs.readdir(c.app);
  const target = path.join(c.app, name), locator = await writeLocator(c.root, target, path.join(c.directory, 'state'));
  const real = await fs.realpath(target);
  for (let run = 0; run < 2; run++) {
    const observed = await warmRun(c, value, counter);
    // The baseline capture and the publication decision (whose staging check
    // shares that read); before, the decision read it twice more.
    assert.equal(observed.reads.filter(file => file === locator).length, 3);
    assert.deepEqual(observed.hashed.map(file => path.relative(real, file).split(path.sep).join('/')).sort(),
      pinned(value).sort());
  }
  assert.equal(counter.downloads, 1);
  assert.deepEqual(counter.maintenance, []);
  assert.equal(counter.launches.length, 3);
});

test('a warm locator-selected home reads its selection once and still refuses damage', async t => {
  const c = await area(t), value = fixture(platform), counter = { downloads: 0, maintenance: [], launches: [] };
  const home = await installImage(value, path.join(c.directory, 'portable', 'stackbite'));
  const locator = await writeLocator(c.root, home, path.join(c.directory, 'state'));
  const real = await fs.realpath(home);
  const observed = await warmRun(c, value, counter);
  // Baseline capture, its staging check, one selection read and the shared
  // publication read; before, the selection was read twice.
  assert.equal(observed.reads.filter(file => file === locator).length, 4);
  assert.deepEqual(observed.hashed.map(file => path.relative(real, file).split(path.sep).join('/')).sort(),
    pinned(value).sort());
  assert.deepEqual(counter.launches.map(launch => launch.executable),
    [path.join(home, platform === 'win32' ? 'stackbite.exe' : 'stackbite')]);
  await fs.writeFile(path.join(home, 'runtime', 'owned.txt'), 'changed');
  await assert.rejects(main(['--status'], options(c, value, counter)), /SHA-256 mismatch: runtime\/owned.txt/);
  assert.equal(counter.downloads, 0);
  assert.deepEqual(counter.maintenance, []);
  assert.equal(counter.launches.length, 1);
});
