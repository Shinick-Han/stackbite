'use strict';
// Company46: an accepted removal journal saved before its capsule existed
// (phase prepared, no recovery_command) and no cached runtime for this package.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { main } = require('../lib/bootstrap');
const { fixture, tar, zip, digest, zipExtract } = require('./fixtures');

const INCARNATION = 'b'.repeat(32);
const arch = platform => platform === 'darwin' ? 'arm64' : 'x64';

function installRoot(environment, platform) {
  return platform === 'win32' ? path.join(environment.LOCALAPPDATA, 'Stackbite')
    : path.join(environment.XDG_DATA_HOME, 'stackbite');
}

async function company(t, platform, changes = {}) {
  const area = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-company46-'));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  const home = path.join(area, 'home');
  const environment = { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(area, 'local'),
    XDG_DATA_HOME: path.join(area, 'data'), XDG_CACHE_HOME: path.join(area, 'cache-home') };
  const root = installRoot(environment, platform);
  await fs.mkdir(root, { recursive: true });
  const journal = path.join(root, '.stackbite-uninstall.json');
  const record = { schema: 'stackbite.uninstall.v1', request_id: 'company46-request', phase: 'prepared',
    accepted: true, removal_requested: true, remaining: [], recovery_command: null,
    install_identity: { root, incarnation: INCARNATION }, ...changes };
  await fs.writeFile(journal, JSON.stringify(record));
  await fs.writeFile(path.join(root, 'default-install.json'),
    JSON.stringify({ installation_id: INCARNATION, home: path.join(area, 'old-payload'), state: path.join(area, 'state') }));
  // The previously installed release is cached under its own key; this package's is not.
  const cache = path.join(area, 'cache');
  await fs.mkdir(path.join(cache, 'v1-' + 'c'.repeat(64)), { recursive: true });
  return { area, environment, root, journal, record, cache };
}

async function snapshot(directory) {
  const out = {};
  async function walk(current) {
    for (const name of (await fs.readdir(current)).sort()) {
      const target = path.join(current, name), info = await fs.lstat(target);
      const relative = path.relative(directory, target).split(path.sep).join('/');
      if (info.isDirectory()) { out[relative + '/'] = true; await walk(target); }
      else out[relative] = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    }
  }
  await walk(directory);
  return out;
}

function options(platform, sample, base, overrides = {}) {
  const stages = [], calls = [];
  const value = { manifest: sample.manifest, platform, arch: arch(platform), glibcVersionRuntime: '2.28',
    environment: base.environment, cache: base.cache, progress: () => {},
    // A Windows ZIP is extracted by Windows' native tar; other hosts stand in for that process only.
    ...(platform === 'win32' ? { extractImpl: zipExtract() } : {}),
    async downloadImpl(spec, archive) { stages.push(path.dirname(archive)); await fs.writeFile(archive, sample.bytes); },
    spawnImpl(executable, args, spawnOptions) {
      calls.push({ executable, args, environment: spawnOptions.env });
      const child = new EventEmitter();
      setImmediate(() => child.emit('exit', 0, null));
      return child;
    }, ...overrides };
  return { value, stages, calls };
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`${platform}: explicit uninstall continues an accepted capsule-less removal with a private pinned runtime`, async t => {
    const base = await company(t, platform), sample = fixture(platform);
    const before = await snapshot(base.area);
    for (const argv of [['uninstall'], ['delete', '--keep-data', '--apply']]) {
      const seen = [];
      const run = options(platform, sample, base, {
        spawnImpl(executable, args, spawnOptions) {
          run.calls.push({ executable, args, environment: spawnOptions.env });
          // The engine runs from the verified stage while the stage exists.
          seen.push(fs.readFile(executable));
          const child = new EventEmitter();
          setImmediate(() => child.emit('exit', 2, null));
          return child;
        } });
      assert.deepEqual(await main(argv, run.value), { code: 2, signal: null });
      assert.equal(run.stages.length, 1);
      assert.equal(run.calls.length, 1);
      const [call] = run.calls, stage = run.stages[0];
      assert.deepEqual(call.args, argv);
      assert.equal(path.dirname(stage), path.resolve(os.tmpdir()));
      assert.equal(call.environment.STACKBITE_HOME, path.join(stage, 'extract', sample.root));
      assert.equal(call.executable, path.join(call.environment.STACKBITE_HOME, sample.image));
      assert.deepEqual(await seen[0], sample.files[sample.image]);
      assert.equal(call.environment.STACKBITE_NPM_REGISTRATION, undefined);
      assert.equal(call.environment.STACKBITE_INSTALL_BASELINE, undefined);
      assert.equal(call.environment.LOCALAPPDATA, base.environment.LOCALAPPDATA);
      // The stage was owned by this run and is gone after the engine exited.
      await assert.rejects(fs.lstat(stage), { code: 'ENOENT' });
    }
    // Nothing was published: no cache entry, locator, preparation or journal change.
    assert.deepEqual(await snapshot(base.area), before);
  });

  test(`${platform}: ordinary launch and setup still refuse the accepted removal without downloading`, async t => {
    const base = await company(t, platform), sample = fixture(platform);
    const before = await snapshot(base.area);
    for (const argv of [[], ['setup']]) {
      const run = options(platform, sample, base, {
        downloadImpl: () => assert.fail('normal launch downloaded during removal'),
        spawnImpl: () => assert.fail('normal launch executed during removal') });
      await assert.rejects(main(argv, run.value), /removal is in progress/);
    }
    assert.deepEqual(await snapshot(base.area), before);
  });
}

function rebuilt(platform, sample, mutate) {
  // Re-pin a modified archive so it passes the size/hash gate and reaches extraction/validation.
  const records = Object.entries(sample.files).map(([name, data]) => ({ name: sample.root + '/' + name, data,
    mode: name === sample.image ? 0o100755 : 0o100644 }));
  mutate(records);
  const bytes = platform === 'win32' ? zip(records) : require('node:zlib').gzipSync(tar(records));
  const key = `${platform}-${arch(platform)}`;
  const manifest = { ...sample.manifest, platforms: { [key]: { ...sample.pinned, sha256: digest(bytes), size: bytes.length } } };
  return { ...sample, bytes, manifest };
}

for (const platform of ['win32', 'linux']) {
  const tampered = {
    'archive bytes': sample => ({ ...sample, bytes: Buffer.concat([sample.bytes.subarray(0, -1), Buffer.from([sample.bytes.at(-1) ^ 1])]) }),
    'pinned manifest': sample => ({ ...sample, manifest: { ...sample.manifest, platforms: { [`${platform}-x64`]: {
      ...sample.pinned, manifestSha256: 'd'.repeat(64) } } } }),
    'unlisted member': sample => rebuilt(platform, sample, records => records.push({ name: sample.root + '/runtime/unlisted.exe', data: 'MZ planted' })),
    'escaping path': sample => rebuilt(platform, sample, records => records.push({ name: sample.root + '/../planted', data: 'planted' })),
    'replaced engine': sample => rebuilt(platform, sample, records => {
      records.find(record => record.name.endsWith('/' + sample.image)).data = Buffer.from(platform === 'win32' ? 'MZplanted' : '\x7fELFplanted');
    })
  };
  for (const [name, change] of Object.entries(tampered)) {
    test(`${platform}: tampered ${name} never executes and leaves no stage`, async t => {
      const base = await company(t, platform), sample = change(fixture(platform));
      const before = await snapshot(base.area);
      const run = options(platform, sample, base, { spawnImpl: () => assert.fail('tampered runtime executed') });
      await assert.rejects(main(['uninstall'], run.value),
        /SHA-256|mismatch|Unsafe archive path|disagree|Pinned archive|Invalid pinned/);
      // The refusal came from verifying the obtained archive, not from skipping the route.
      assert.equal(run.stages.length, 1);
      for (const stage of run.stages) await assert.rejects(fs.lstat(stage), { code: 'ENOENT' });
      assert.deepEqual(await snapshot(base.area), before);
    });
  }
}

test('a corrupt cached runtime of this release stays an error and is never replaced by a download', async t => {
  const platform = 'linux', base = await company(t, platform), sample = fixture(platform);
  const spec = require('../lib/bootstrap').releaseSpec(sample.manifest, platform, 'x64', { glibcVersionRuntime: '2.28' });
  const key = createHash('sha256').update(JSON.stringify([spec.version, spec.commit, spec.key, spec.sha256])).digest('hex');
  const target = path.join(base.cache, `v1-${key}`);
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'SHA256SUMS.json'), '{"planted":"payload"}');
  await fs.writeFile(path.join(target, 'portable.json'), '{}');
  const run = options(platform, sample, base, {
    downloadImpl: () => assert.fail('corrupt cache downloaded a replacement'),
    spawnImpl: () => assert.fail('corrupt cache executed') });
  await assert.rejects(main(['uninstall'], run.value), /SHA-256 mismatch/);
});

const ineligible = {
  'reinstalled (another incarnation)': async base => fs.writeFile(path.join(base.root, 'default-install.json'),
    JSON.stringify({ installation_id: 'e'.repeat(32), home: path.join(base.area, 'new'), state: path.join(base.area, 'state') })),
  'capsule already recorded': async base => fs.writeFile(base.journal,
    JSON.stringify({ ...base.record, recovery_command: ['sh', base.journal.replace(/\.json$/, '.sh')] })),
  'not accepted': async base => fs.writeFile(base.journal, JSON.stringify({ ...base.record, accepted: false })),
  'past prepared': async base => fs.writeFile(base.journal, JSON.stringify({ ...base.record, phase: 'stopped' })),
  'another installation root': async base => fs.writeFile(base.journal,
    JSON.stringify({ ...base.record, install_identity: { root: path.join(base.area, 'elsewhere'), incarnation: INCARNATION } }))
};
for (const [name, change] of Object.entries(ineligible)) {
  test(`${name}: the old journal never obtains a runtime`, async t => {
    const platform = 'linux', base = await company(t, platform), sample = fixture(platform);
    await change(base);
    const before = await snapshot(base.area);
    const run = options(platform, sample, base, {
      downloadImpl: () => assert.fail('ineligible journal downloaded a runtime'),
      spawnImpl: () => assert.fail('ineligible journal executed') });
    await assert.rejects(main(['uninstall'], run.value), /not cached/);
    assert.deepEqual(await snapshot(base.area), before);
  });
}

test('preview and help stay read-only and obtain no runtime', async t => {
  const platform = 'win32', base = await company(t, platform), sample = fixture(platform);
  const before = await snapshot(base.area);
  for (const argv of [['uninstall', '--preview'], ['delete', '--preview'], ['uninstall', '--help']]) {
    const run = options(platform, sample, base, {
      downloadImpl: () => assert.fail('preview downloaded a runtime'),
      spawnImpl: () => assert.fail('preview executed') });
    await assert.rejects(main(argv, run.value), /not cached/);
  }
  assert.deepEqual(await snapshot(base.area), before);
});

test('a journal changed while staging is not continued by the staged runtime', async t => {
  const platform = 'win32', base = await company(t, platform), sample = fixture(platform);
  const run = options(platform, sample, base, {
    async downloadImpl(spec, archive) {
      run.stages.push(path.dirname(archive));
      await fs.writeFile(base.journal, JSON.stringify({ ...base.record, request_id: 'another-request' }));
      await fs.writeFile(archive, sample.bytes);
    },
    spawnImpl: () => assert.fail('changed journal executed') });
  await assert.rejects(main(['uninstall'], run.value), /changed while staging/);
  await assert.rejects(fs.lstat(run.stages[0]), { code: 'ENOENT' });
});

for (const platform of ['win32', 'linux']) {
  test(`${platform}: a helper handed the removal keeps its staged runtime; finished or foreign handoffs do not`, async t => {
    const base = await company(t, platform), sample = fixture(platform);
    const cases = [
      // The engine hands off to a helper started from its own image and exits.
      { name: 'waiting helper', keep: true, write: (record, executable) => ({ ...record,
        parent_resume: { state: 'waiting', runtime: { path: executable, sha256: digest(sample.files[sample.image]) } } }) },
      { name: 'finalized', keep: false, write: null },
      { name: 'other request', keep: false, write: (record, executable) => ({ ...record, request_id: 'other',
        parent_resume: { state: 'waiting', runtime: { path: executable } } }) },
      { name: 'installed runtime', keep: false, write: record => ({ ...record,
        parent_resume: { state: 'waiting', runtime: { path: path.join(base.area, 'old-payload', sample.image) } } }) }
    ];
    for (const item of cases) {
      await fs.writeFile(base.journal, JSON.stringify(base.record));
      const run = options(platform, sample, base, {
        spawnImpl(executable, args, spawnOptions) {
          run.calls.push({ executable, args, environment: spawnOptions.env });
          const child = new EventEmitter();
          setImmediate(async () => {
            if (item.write) await fs.writeFile(base.journal, JSON.stringify(item.write(base.record, executable)));
            else await fs.unlink(base.journal);
            child.emit('exit', item.keep ? 2 : 0, null);
          });
          return child;
        } });
      const result = await main(['uninstall'], run.value);
      assert.deepEqual(result, { code: item.keep ? 2 : 0, signal: null }, item.name);
      const stage = run.stages[0];
      if (item.keep) {
        t.after(() => fs.rm(stage, { recursive: true, force: true }));
        assert.deepEqual(await fs.readFile(run.calls[0].executable), sample.files[sample.image], item.name);
      } else await assert.rejects(fs.lstat(stage), { code: 'ENOENT' }, item.name);
      if (!item.write) assert.equal(await fs.readdir(base.cache).then(names => names.length), 1);
    }
  });
}

test('a runtime that cannot start leaves no stage and reports the start failure', async t => {
  const platform = 'linux', base = await company(t, platform), sample = fixture(platform);
  const run = options(platform, sample, base, {
    spawnImpl() { const child = new EventEmitter(); setImmediate(() => child.emit('error', new Error('ENOEXEC'))); return child; } });
  await assert.rejects(main(['uninstall'], run.value), /Cannot start the verified native Stackbite executable/);
  await assert.rejects(fs.lstat(run.stages[0]), { code: 'ENOENT' });
});

test('the ZIP stand-in extracts exactly the pinned members, as native tar does where it reads ZIP', async t => {
  const area = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-company46-'));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  const sample = fixture('win32'), archive = path.join(area, sample.pinned.asset);
  const spec = require('../lib/bootstrap').releaseSpec(sample.manifest, 'win32', 'x64');
  await fs.writeFile(archive, sample.bytes);
  const trees = {};
  for (const host of new Set(['linux', process.platform])) {
    const destination = path.join(area, host);
    await fs.mkdir(destination);
    await zipExtract(host)(archive, destination, spec);
    trees[host] = await snapshot(destination);
  }
  const files = Object.fromEntries(Object.entries(trees.linux).filter(([name]) => !name.endsWith('/')));
  assert.deepEqual(files, Object.fromEntries(Object.entries(sample.files)
    .map(([name, bytes]) => [sample.root + '/' + name, digest(bytes)]).sort(([a], [b]) => a < b ? -1 : 1)));
  for (const tree of Object.values(trees)) assert.deepEqual(tree, trees.linux);
  // The package refuses an escaping member before the stand-in is started; the stand-in itself never writes outside.
  const escaping = rebuilt('win32', sample, records => records.push({ name: sample.root + '/../../planted', data: 'planted' }));
  const hostile = path.join(area, 'hostile'), target = path.join(hostile, 'inner');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(archive, escaping.bytes);
  await assert.rejects(zipExtract('linux')(archive, target, { ...spec, sha256: escaping.manifest.platforms['win32-x64'].sha256 }),
    /Unsafe archive path/);
  const { zipTarStandIn } = require('./fixtures');
  assert.equal(await new Promise(resolve => zipTarStandIn('tar', ['-xf', archive, '-C', target]).once('close', resolve)), 1);
  assert.deepEqual(await fs.readdir(hostile), ['inner']);
});
