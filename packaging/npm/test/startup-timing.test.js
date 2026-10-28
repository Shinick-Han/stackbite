'use strict';
// Optional launcher phase timing over disposable fixtures and an inert child only:
// no release download, native binary, backend, provider or installed state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { main } = require('../lib/bootstrap');
const timing = require('../lib/startup-timing');
const { fixture } = require('./fixtures');

const KEYS = ['schema', 'pid', 'phase', 'start_ms', 'ms', 'wall_ms', 'outcome'];

async function owned(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-npm-timing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  timing.resetForTest();
  return directory;
}
const writeFixture = value => async (spec, target) => fs.writeFile(target, value.bytes, { flag: 'wx' });
function inertChild(calls) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
}
async function records(file) {
  try { return (await fs.readFile(file, 'ascii')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function launch(area, value, environment, calls, argv = ['--rooms', 'secret-argument']) {
  return main(argv, { manifest: value.manifest, platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.35',
    cache: path.join(area, 'cache'), downloadImpl: writeFixture(value), environment,
    progress: () => {}, spawnImpl: inertChild(calls) });
}

test('disabled or relative timing target writes nothing and launches unchanged', async t => {
  const area = await owned(t), value = fixture(), calls = [];
  const cwd = process.cwd();
  process.chdir(area);
  try {
    assert.deepEqual(await launch(area, value, {}, calls), { code: 0, signal: null });
    assert.deepEqual(await launch(area, value, { [timing.ENVIRONMENT]: 'relative.jsonl' }, calls), { code: 0, signal: null });
  } finally { process.chdir(cwd); }
  assert.equal(calls.length, 2);
  assert.deepEqual((await fs.readdir(area)).sort(), ['cache']);
});

test('enabled timing records the full verification then the exec mark, without arguments or paths', async t => {
  const area = await owned(t), value = fixture(), calls = [], file = path.join(area, 'timing.jsonl');
  const environment = { [timing.ENVIRONMENT]: file };
  assert.deepEqual(await launch(area, value, environment, calls), { code: 0, signal: null });
  assert.deepEqual(await launch(area, value, environment, calls), { code: 0, signal: null });
  const lines = await records(file);
  assert.deepEqual(lines.map(item => [item.phase, item.outcome]),
    [['launcher.ensure', 'ok'], ['launcher.exec', 'ok'], ['launcher.ensure', 'ok'], ['launcher.exec', 'ok']]);
  for (const item of lines) {
    assert.deepEqual(Object.keys(item), KEYS);
    assert.equal(item.schema, timing.SCHEMA); assert.equal(item.pid, process.pid);
    assert.ok(item.start_ms >= 0 && item.ms >= 0 && Number.isInteger(item.wall_ms));
  }
  assert.equal(lines[1].ms, 0);
  assert.ok(lines[1].start_ms >= lines[0].start_ms + lines[0].ms);
  const text = await fs.readFile(file, 'ascii');
  for (const forbidden of ['secret-argument', area, 'cache', value.root, 'v1-']) assert.ok(!text.includes(forbidden));
  // The native child inherits the variable so its own phases line up by wall_ms.
  assert.equal(calls[0].options.env[timing.ENVIRONMENT], file);
});

test('a refused tampered payload records a raised verification and never an exec mark', async t => {
  const area = await owned(t), value = fixture(), calls = [], file = path.join(area, 'timing.jsonl');
  const environment = { [timing.ENVIRONMENT]: file };
  await launch(area, value, environment, calls);
  const [home] = await fs.readdir(path.join(area, 'cache'));
  await fs.writeFile(path.join(area, 'cache', home, 'runtime', 'owned.txt'), 'tampered runtime fixtur');
  await assert.rejects(launch(area, value, environment, calls), /SHA-256 mismatch/);
  assert.equal(calls.length, 1);
  assert.deepEqual((await records(file)).map(item => [item.phase, item.outcome]),
    [['launcher.ensure', 'ok'], ['launcher.exec', 'ok'], ['launcher.ensure', 'raised']]);
});

test('setup records verification only; an unwritable target and the record cap never change the result', async t => {
  const area = await owned(t), value = fixture(), calls = [], file = path.join(area, 'timing.jsonl');
  assert.deepEqual(await launch(area, value, { [timing.ENVIRONMENT]: file }, calls, ['setup']), { code: 0, signal: null });
  assert.deepEqual((await records(file)).map(item => item.phase), ['launcher.ensure']);
  assert.equal(calls.length, 0);
  const missing = path.join(area, 'missing', 'timing.jsonl');
  assert.deepEqual(await launch(area, value, { [timing.ENVIRONMENT]: missing }, calls), { code: 0, signal: null });
  timing.resetForTest();
  const capped = path.join(area, 'capped.jsonl');
  for (let index = 0; index < timing.MAX_RECORDS + 5; index++) timing.mark({ [timing.ENVIRONMENT]: capped }, 'launcher.exec');
  assert.equal((await records(capped)).length, timing.MAX_RECORDS);
});
