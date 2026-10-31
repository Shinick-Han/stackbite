'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { fixture } = require('./fixtures');
const { releaseSpec, ensureBinary, validatePayload, main } = require('../lib/bootstrap');

async function install(t, platform) {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-s36-phone-'));
  t.after(() => fs.rm(cache, { recursive: true, force: true }));
  const value = fixture(platform, {}, {
    'phone/stackbite-phone-host': Buffer.from('unused phone host'),
    'phone/stackbite-phone-components.json': Buffer.from('unused phone manifest'),
    'stackbite-agent': Buffer.from('mandatory provider helper'),
    'private_pty/_native/core': Buffer.from('mandatory native library'),
    'stackbite-tui': Buffer.from('mandatory TUI'),
  });
  const spec = releaseSpec(value.manifest, platform, platform === 'darwin' ? 'arm64' : 'x64', { glibcVersionRuntime: '2.28' });
  const options = { cache, downloadImpl: (_, file) => fs.writeFile(file, value.bytes),
    extractImpl: async (_, destination) => {
      for (const [name, bytes] of Object.entries(value.files)) {
        const file = path.join(destination, value.root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes, { mode: name === value.image ? 0o755 : 0o644 });
      }
    } };
  const installed = await ensureBinary(spec, options);
  return { value, spec, options, installed };
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`${platform}: cached TUI reaches spawn with damaged/missing optional Phone; activation/setup refuse`, async t => {
    const { value, spec, options, installed } = await install(t, platform);
    let spawns = 0;
    const cached = { ...options, manifest: value.manifest, platform,
      arch: platform === 'darwin' ? 'arm64' : 'x64', glibcVersionRuntime: '2.28', environment: {},
      downloadImpl: () => assert.fail('cache must not download'), progress: () => {},
      spawnImpl: () => {
        spawns++;
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 0, null));
        return child;
      } };
    await fs.writeFile(path.join(installed.home, 'phone/stackbite-phone-host'), 'damaged');
    assert.deepEqual(await main([], cached), { code: 0, signal: null });
    assert.equal(spawns, 1);
    await assert.rejects(main(['phone', 'serve'], cached), /SHA-256 mismatch/);
    await assert.rejects(main(['setup', '--check'], cached), /SHA-256 mismatch/);
    assert.equal(spawns, 1);
    await fs.rm(path.join(installed.home, 'phone'), { recursive: true });
    assert.deepEqual(await ensureBinary(spec, cached), installed);
    await assert.rejects(validatePayload(installed.home, spec), /disagree with pinned manifest/);
    // Install validation still covers Phone, including the published final path.
    const other = await fs.mkdtemp(path.join(options.cache, 'first-install-'));
    await assert.rejects(ensureBinary(spec, { ...options, cache: other,
      extractImpl: async (...args) => {
        await options.extractImpl(...args);
        await fs.writeFile(path.join(args[1], value.root, 'phone/stackbite-phone-host'), 'bad extraction');
      } }), /SHA-256 mismatch/);
  });

  for (const name of ['runtime/owned.txt', 'stackbite-agent', 'private_pty/_native/core', 'stackbite-tui']) {
    test(`${platform}: selected runtime refuses tampered ${name}`, async t => {
      const { spec, options, installed } = await install(t, platform);
      await fs.writeFile(path.join(installed.home, name), 'tampered mandatory bytes');
      await assert.rejects(ensureBinary(spec, options), /SHA-256 mismatch/);
    });
  }
}

test('a mandatory runtime link cannot resolve into deferred Phone', async t => {
  const { spec, options, installed } = await install(t, 'linux');
  const mandatory = path.join(installed.home, 'runtime/owned.txt');
  await fs.writeFile(path.join(installed.home, 'phone/copy'), 'fixed runtime fixture');
  await fs.unlink(mandatory);
  try { await fs.symlink('../phone/copy', mandatory); }
  catch (error) { if (error.code === 'EPERM') return t.skip('symlinks unavailable'); throw error; }
  await assert.rejects(ensureBinary(spec, options), /resolves into optional Phone/);
});
