'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { main, ensureBinary, releaseSpec } = require('../lib/bootstrap');
const { parseSetup } = require('../lib/setup');
const { cacheDirectory } = require('../lib/cache');
const { fixture } = require('./fixtures');
const { download } = require('../lib/download');

async function owned(t) {
  const area = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-setup-owned-'));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  return area;
}
function options(area, value = fixture()) {
  const output = [];
  return { manifest: value.manifest, platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.35',
    cache: path.join(area, 'cache'), environment: { STACKBITE_STATE_DIR: path.join(area, 'state'), TOKEN: 'secret-fixture' },
    stderr: { write: text => output.push(text) }, output,
    downloadImpl: (_, destination) => fs.writeFile(destination, value.bytes, { flag: 'wx' }),
    spawnImpl: () => assert.fail('setup must not start an app/backend') };
}
async function withoutWrites(action) {
  const methods = ['mkdir', 'mkdtemp', 'writeFile', 'rename', 'rm', 'chmod', 'unlink', 'copyFile'];
  const originals = new Map(methods.map(name => [name, fs[name]]));
  try {
    for (const name of methods) fs[name] = () => assert.fail(`check must not call fs.${name}`);
    return await action();
  } finally { for (const [name, original] of originals) fs[name] = original; }
}

test('only the leading setup command and its single --check flag are consumed', () => {
  assert.deepEqual(parseSetup(['setup']), { checkOnly: false });
  assert.deepEqual(parseSetup(['setup', '--check']), { checkOnly: true });
  for (const argv of [[], ['--check'], ['room', 'setup'], ['--', 'setup'], ['setup-room']]) assert.equal(parseSetup(argv), null);
  for (const argv of [['setup', '--other'], ['setup', '--check', '--check'], ['setup', '--check=true'], ['setup', 'room']]) {
    assert.throws(() => parseSetup(argv), /Usage: stackbite setup/);
  }
});

test('cold setup prepares the pinned runtime, reports safe stages, and never starts a backend', async t => {
  const area = await owned(t), value = fixture(), config = options(area, value);
  assert.deepEqual(await main(['setup'], config), { code: 0, signal: null });
  assert.deepEqual(config.output, [
    'Stackbite: Downloading pinned runtime...\n', 'Stackbite: Verifying archive...\n',
    'Stackbite: Extracting runtime...\n', 'Stackbite: Validating runtime files...\n',
    'Stackbite: Publishing runtime cache...\n', 'Stackbite: Validating published runtime...\n',
    'Stackbite: Pinned runtime is ready.\n'
  ]);
  assert.doesNotMatch(config.output.join(''), /https?:|secret-fixture|TOKEN|STATE_DIR/);
  assert.deepEqual(await fs.readdir(area), ['cache']);
  assert.equal((await fs.readdir(config.cache)).length, 1);
});

test('setup with a fake streamed HTTPS/CDN download never prints credential URLs', async t => {
  const area = await owned(t), value = fixture(), config = options(area, value);
  let requests = 0;
  const request = (url, settings, callback) => {
    const req = new EventEmitter();
    const response = Readable.from(requests++ === 0 ? [] : [value.bytes.subarray(0, 17), value.bytes.subarray(17)]);
    response.statusCode = requests === 1 ? 302 : 200;
    response.headers = requests === 1 ? { location: 'https://release-assets.githubusercontent.com/fixture?signature=secret-fixture' }
      : { 'content-length': String(value.bytes.length) };
    queueMicrotask(() => callback(response)); return req;
  };
  config.downloadImpl = (spec, destination) => download(spec, destination, { request });
  await main(['setup'], config);
  assert.equal(requests, 2);
  assert.doesNotMatch(config.output.join(''), /https?:|signature|secret-fixture/);
});

test('Windows ZIP setup follows the same prepare/check contract without starting the app', async t => {
  if (process.platform !== 'win32') return t.skip('Windows ZIP requires Windows native bsdtar');
  const area = await owned(t), config = { ...options(area, fixture('win32')), platform: 'win32' };
  await main(['setup'], config);
  config.downloadImpl = () => assert.fail('prepared Windows check must not download');
  await withoutWrites(() => main(['setup', '--check'], config));
});

test('cached setup/check performs complete validation without network, extraction, writes or spawn', async t => {
  const area = await owned(t), config = options(area);
  await main(['setup'], config);
  config.downloadImpl = () => assert.fail('cached check/setup must not download');
  config.extractImpl = () => assert.fail('cached check/setup must not extract');
  for (const argv of [['setup', '--check'], ['setup']]) {
    config.output.length = 0;
    await withoutWrites(() => main(argv, config));
    assert.deepEqual(config.output, ['Stackbite: Validating runtime files...\n', 'Stackbite: Pinned runtime is ready.\n']);
  }
});

test('missing cache/check is read-only even with missing parents or a different release cache', async t => {
  const area = await owned(t), config = options(area);
  config.downloadImpl = () => assert.fail('check must not download');
  for (const cache of [path.join(area, 'missing', 'nested'), area]) {
    await withoutWrites(() => assert.rejects(main(['setup', '--check'], { ...config, cache }), /not cached; run stackbite setup/));
  }
  assert.deepEqual(await fs.readdir(area), []);
});

test('invalid setup arguments fail before cache access or download', async t => {
  const area = await owned(t), config = options(area);
  await withoutWrites(() => assert.rejects(main(['setup', '--check', 'room'], config), /Usage/));
  assert.deepEqual(await fs.readdir(area), []);
});

test('failed setup cleans its staging, publishes nothing and can be retried', async t => {
  const area = await owned(t), config = options(area);
  await assert.rejects(main(['setup'], { ...config, downloadImpl: async (_, destination) => {
    await fs.writeFile(destination, 'partial fixture'); throw new Error('owned download interrupted');
  } }), /interrupted/);
  assert.deepEqual(await fs.readdir(config.cache), []);
  assert.doesNotMatch(config.output.join(''), /ready/);
  await main(['setup'], config);
  assert.equal((await fs.readdir(config.cache)).length, 1);
});

test('concurrent setups publish one validated cache and leave unrelated staging intact', async t => {
  const area = await owned(t), config = options(area);
  await fs.mkdir(config.cache);
  const unrelated = path.join(config.cache, '.staging-not-owned');
  await fs.mkdir(unrelated); await fs.writeFile(path.join(unrelated, 'receipt'), 'keep');
  await Promise.all([main(['setup'], config), main(['setup'], config)]);
  assert.equal((await fs.readdir(config.cache)).length, 2);
  assert.equal(await fs.readFile(path.join(unrelated, 'receipt'), 'utf8'), 'keep');
  await main(['setup', '--check'], config);
});

test('cached check and warm launch reject same-size tampering with restored timestamps', async t => {
  const area = await owned(t), value = fixture(), config = options(area, value);
  await main(['setup'], config);
  const installed = await ensureBinary(releaseSpec(value.manifest, 'linux', 'x64'), config);
  const file = path.join(installed.home, 'runtime', 'owned.txt'), before = await fs.stat(file);
  await fs.writeFile(file, Buffer.alloc(before.size, 65)); await fs.utimes(file, before.atime, before.mtime);
  config.downloadImpl = () => assert.fail('corrupt cache must not be replaced');
  for (const argv of [['setup', '--check'], ['setup'], ['--status']]) {
    config.output.length = 0;
    await assert.rejects(main(argv, config), /file SHA-256 mismatch/);
    assert.doesNotMatch(config.output.join(''), /ready/);
  }
  assert.deepEqual(await fs.readFile(file), Buffer.alloc(before.size, 65));
});

test('check rejects linked cache ancestors and unexpected payload files', async t => {
  const area = await owned(t), config = options(area);
  await main(['setup'], config);
  const [name] = await fs.readdir(config.cache);
  await fs.writeFile(path.join(config.cache, name, 'extra'), 'unlisted');
  await withoutWrites(() => assert.rejects(main(['setup', '--check'], config), /disagree with pinned manifest/));
  const link = path.join(area, 'link');
  await fs.symlink(config.cache, link, process.platform === 'win32' ? 'junction' : 'dir');
  await withoutWrites(() => assert.rejects(main(['setup', '--check'], { ...config, cache: path.join(link, 'nested') }), /Cache directory/));
});

test('warm launches stay quiet and preserve native arguments containing setup', async t => {
  const area = await owned(t), config = options(area);
  await main(['setup'], config); config.output.length = 0;
  const argv = ['room', 'setup', '--check'];
  config.downloadImpl = () => assert.fail('warm launch must not download');
  config.spawnImpl = (executable, args, settings) => {
    assert.deepEqual(args, argv); assert.equal(settings.env.STACKBITE_STATE_DIR, config.environment.STACKBITE_STATE_DIR);
    const child = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => child.emit('exit', 9, null)); return child;
  };
  assert.deepEqual(await main(argv, config), { code: 9, signal: null });
  assert.deepEqual(config.output, []);
});

test('real npm entrypoint check fails offline without creating cache or state', async t => {
  const area = await owned(t);
  const environment = { ...process.env, LOCALAPPDATA: area, XDG_CACHE_HOME: area, STACKBITE_STATE_DIR: path.join(area, 'state') };
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/stackbite.js'), 'setup', '--check'],
    { env: environment, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /not cached; run stackbite setup/);
  assert.deepEqual(await fs.readdir(area), []);
});

test('cache defaults are local and existing platform overrides remain honored', () => {
  const home = path.resolve('owned-home');
  assert.equal(cacheDirectory({}, 'linux', home), path.join(home, '.cache', 'stackbite'));
  assert.equal(cacheDirectory({ HOME: home, XDG_CACHE_HOME: path.join(home, 'xdg') }, 'linux'), path.join(home, 'xdg', 'stackbite'));
  assert.equal(cacheDirectory({ LOCALAPPDATA: home }, 'win32'), path.join(home, 'Stackbite', 'cache'));
});
