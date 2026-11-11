'use strict';
// Core-only and full (Phone) release shapes over disposable fixtures; nothing is
// downloaded from a network and no native image runs (spawn is a test double).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { fixture, publishFixture } = require('./fixtures');
const { releaseSpec, ensureBinary, validatePayload, main } = require('../lib/bootstrap');

const CORE = { 'stackbite-agent': Buffer.from('mandatory provider helper'), 'stackbite-tui': Buffer.from('mandatory TUI') };
const PHONE = { 'phone/stackbite-phone-host': Buffer.from('phone host'),
  'phone/stackbite-phone-components.json': Buffer.from('phone component manifest') };
const arch = platform => platform === 'darwin' ? 'arm64' : 'x64';

async function setup(t, platform, files) {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-core-only-'));
  t.after(() => fs.rm(cache, { recursive: true, force: true }));
  const value = fixture(platform, {}, files);
  const spec = releaseSpec(value.manifest, platform, arch(platform), { glibcVersionRuntime: '2.28' });
  let downloads = 0, spawns = 0;
  const options = { cache, runtime: cache, publishImpl: publishFixture,
    downloadImpl: async (_, file) => { downloads++; await fs.writeFile(file, value.bytes); },
    extractImpl: async (_, destination) => {
      for (const [name, bytes] of Object.entries(value.files)) {
        const file = path.join(destination, value.root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes, { mode: name === value.image ? 0o755 : 0o644 });
      }
    } };
  const run = { ...options, manifest: value.manifest, platform, arch: arch(platform), glibcVersionRuntime: '2.28',
    environment: {}, progress: () => {}, stdout: { write() {} }, stderr: { write() {} },
    spawnImpl: () => { spawns++; const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0, null)); return child; } };
  return { value, spec, options, run, counts: () => ({ downloads, spawns }) };
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`${platform}: a core release (no Phone members) installs, starts and answers without Phone bits`, async t => {
    const { value, spec, options, run, counts } = await setup(t, platform, CORE);
    assert.ok(!Object.keys(value.files).some(name => name.startsWith('phone/')));
    // Cold --version/--help answer from the pin: no download, no runtime.
    for (const argv of [['--version'], ['--help']]) assert.deepEqual(await main(argv, run), { code: 0, signal: null });
    assert.deepEqual(counts(), { downloads: 0, spawns: 0 });
    const installed = await ensureBinary(spec, options);
    assert.equal(counts().downloads, 1);
    await assert.rejects(fs.lstat(path.join(installed.home, 'phone')), { code: 'ENOENT' });
    // Warm core start, setup --check and explicit Phone activation all validate
    // the complete core inventory; none downloads anything (no silent fetch).
    for (const argv of [[], ['--version'], ['setup', '--check'], ['phone', 'serve']]) {
      assert.deepEqual(await main(argv, { ...run, downloadImpl: () => assert.fail('cache must not download') }),
        { code: 0, signal: null });
    }
    assert.deepEqual(counts(), { downloads: 1, spawns: 3 });
    for (const includePhone of [false, true]) {
      assert.equal(await validatePayload(installed.home, spec, { includePhone }), installed.executable);
    }
  });

  test(`${platform}: a core release refuses an undeclared phone/ file on every path`, async t => {
    const { spec, options, run } = await setup(t, platform, CORE);
    const installed = await ensureBinary(spec, options);
    await fs.mkdir(path.join(installed.home, 'phone'));
    await fs.writeFile(path.join(installed.home, 'phone', 'stackbite-phone-host'), 'unknown');
    for (const includePhone of [false, true]) {
      await assert.rejects(validatePayload(installed.home, spec, { includePhone }), /disagree with pinned manifest/);
    }
    await assert.rejects(main([], { ...run, downloadImpl: () => assert.fail('no download') }), /disagree with pinned manifest/);
  });

  test(`${platform}: a core release still refuses tampered, extra and misidentified members`, async t => {
    const { spec, options } = await setup(t, platform, CORE);
    const installed = await ensureBinary(spec, options);
    await fs.writeFile(path.join(installed.home, 'extra.bin'), 'extra');
    await assert.rejects(validatePayload(installed.home, spec, { includePhone: false }), /disagree with pinned manifest/);
    await fs.rm(path.join(installed.home, 'extra.bin'));
    await fs.writeFile(path.join(installed.home, 'stackbite-tui'), 'tampered');
    await assert.rejects(validatePayload(installed.home, spec, { includePhone: false }), /SHA-256 mismatch/);
    await fs.writeFile(path.join(installed.home, 'stackbite-tui'), CORE['stackbite-tui']);
    // Another product version under the same pinned documents is not this release.
    const other = { ...spec, version: '0.0.1' };
    await assert.rejects(validatePayload(installed.home, other, { includePhone: false }), /identity mismatch/);
  });

  test(`${platform}: a full release keeps its declared Phone check at activation`, async t => {
    const { spec, options, run, counts } = await setup(t, platform, { ...CORE, ...PHONE });
    const installed = await ensureBinary(spec, options);
    assert.equal(await validatePayload(installed.home, spec), installed.executable);
    await fs.writeFile(path.join(installed.home, 'phone/stackbite-phone-host'), 'corrupt');
    const cached = { ...run, downloadImpl: () => assert.fail('no download at Phone activation') };
    assert.deepEqual(await main([], cached), { code: 0, signal: null });
    await assert.rejects(main(['phone', 'serve'], cached), /SHA-256 mismatch/);
    await fs.rm(path.join(installed.home, 'phone'), { recursive: true });
    assert.deepEqual(await main([], cached), { code: 0, signal: null });
    await assert.rejects(main(['phone', 'serve'], cached), /disagree with pinned manifest/);
    assert.deepEqual(counts(), { downloads: 1, spawns: 2 });
  });
}

test('a pinned Phone member set without its component manifest is not a full release', async t => {
  const { spec, options } = await setup(t, 'linux', { ...CORE, 'phone/stackbite-phone-host': Buffer.from('host only') });
  await assert.rejects(ensureBinary(spec, options), /Phone component manifest is not pinned/);
});
