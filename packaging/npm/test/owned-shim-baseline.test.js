'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { main } = require('../lib/bootstrap');
const { ownCommandLink } = require('../lib/uninstall-registration');
const { fixture, publishFixture } = require('./fixtures');

async function fresh(t, platform = 'linux') {
  const area = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'npm-baseline-')));
  t.after(() => fs.rm(area, { recursive: true, force: true }));
  const home = path.join(area, 'home'), prefix = path.join(home, '.local');
  const packageRoot = path.join(prefix, 'lib/node_modules/stackbite');
  const entry = path.join(packageRoot, 'packaging/npm/bin/stackbite.js');
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, '// inert npm entry');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'stackbite',
    bin: { stackbite: 'packaging/npm/bin/stackbite.js' } }));
  const npmCli = path.join(area, 'npm-cli.js'); await fs.writeFile(npmCli, '// inert tool');
  const shim = path.join(prefix, 'bin/stackbite'); await fs.mkdir(path.dirname(shim));
  const root = path.join(home, '.local/share/stackbite');
  const value = fixture(platform), cache = path.join(area, 'cache');
  let downloads = 0, publications = 0;
  const options = { packageRoot, npmCli, platform, arch: platform === 'darwin' ? 'arm64' : 'x64',
    glibcVersionRuntime: '2.28', manifest: value.manifest, cache,
    environment: { HOME: home, USERPROFILE: home }, progress() {},
    async downloadImpl(spec, archive) { downloads++; await fs.writeFile(archive, value.bytes); },
    async publishImpl(...args) { publications++; await publishFixture(...args); },
    spawnImpl() { assert.fail('setup must not launch an inert image'); } };
  return { area, home, packageRoot, entry, shim, root, options,
    counts: () => [downloads, publications] };
}
async function symlink(t, target, file) {
  try { await fs.symlink(target, file, 'file'); return true; }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows host does not permit file symlinks'); return false;
  }
}
async function npmLink(t, c) {
  return symlink(t, '../lib/node_modules/stackbite/packaging/npm/bin/stackbite.js', c.shim);
}

for (const platform of ['linux', 'darwin']) for (const present of [false, true]) {
  test(`fresh ${platform} setup with default npm prefix and own link=${present}`, async t => {
    const c = await fresh(t, platform);
    if (present && !await npmLink(t, c)) return;
    assert.equal(c.options.environment.STACKBITE_INSTALL_BASELINE, undefined);
    await assert.rejects(fs.stat(c.root), { code: 'ENOENT' });
    assert.deepEqual(await main(['setup'], c.options), { code: 0, signal: null });
    assert.deepEqual(c.counts(), [1, 1]);
    if (present) assert.equal(await fs.readlink(c.shim), '../lib/node_modules/stackbite/packaging/npm/bin/stackbite.js');
  });
}

for (const platform of ['linux', 'darwin']) {
  test(`fresh ${platform} setup also accepts the direct absolute npm entry`, async t => {
    const c = await fresh(t, platform); if (!await symlink(t, c.entry, c.shim)) return;
    assert.equal(await ownCommandLink(c.shim, c.packageRoot, platform), true);
    await main(['setup'], c.options);
    assert.deepEqual(c.counts(), [1, 1]);
    assert.equal(await fs.readlink(c.shim), c.entry);
  });

  for (const kind of ['redirect', 'redirect-chain', 'directory-alias', 'command-chain',
    'parent', 'dot-alias', 'missing-parent', 'wrong-existing', 'deleted-entry']) {
    test(`fresh ${platform} setup refuses ${kind} target before download/publication`, async t => {
      const c = await fresh(t, platform);
      const relative = '../lib/node_modules/stackbite/packaging/npm/bin/stackbite.js';
      const foreign = path.join(c.area, 'foreign');
      const foreignEntry = path.join(foreign, 'node_modules/stackbite/packaging/npm/bin/stackbite.js');
      await fs.mkdir(path.dirname(foreignEntry), { recursive: true });
      await fs.mkdir(path.join(foreign, 'child'));
      await fs.writeFile(foreignEntry, '// foreign command');
      const targets = {
        redirect: '../lib/redirect/../node_modules/stackbite/packaging/npm/bin/stackbite.js',
        'redirect-chain': '../lib/redirect/../node_modules/stackbite/packaging/npm/bin/stackbite.js',
        'directory-alias': '../lib/alias/packaging/npm/bin/stackbite.js',
        'command-chain': '../lib/entry-alias',
        parent: '../lib/child/../node_modules/stackbite/packaging/npm/bin/stackbite.js',
        'dot-alias': '../lib/./node_modules/stackbite/packaging/npm/bin/stackbite.js',
        'missing-parent': '../lib/missing/../node_modules/stackbite/packaging/npm/bin/stackbite.js',
        'wrong-existing': foreignEntry,
        'deleted-entry': relative,
      };
      const target = targets[kind];
      if (!await symlink(t, target, c.shim)) return;
      const lib = path.join(c.home, '.local/lib');
      if (kind === 'redirect') await fs.symlink(path.join(foreign, 'child'), path.join(lib, 'redirect'), 'dir');
      if (kind === 'redirect-chain') {
        await fs.symlink('redirect-hop', path.join(lib, 'redirect'), 'dir');
        await fs.symlink(path.join(foreign, 'child'), path.join(lib, 'redirect-hop'), 'dir');
      }
      if (kind === 'directory-alias') await fs.symlink(c.packageRoot, path.join(lib, 'alias'), 'dir');
      if (kind === 'command-chain') await fs.symlink(c.entry, path.join(lib, 'entry-alias'), 'file');
      if (kind === 'parent') await fs.mkdir(path.join(lib, 'child'));
      if (kind === 'deleted-entry') await fs.unlink(c.entry);
      if (kind.startsWith('redirect')) {
        // This is the actual OS target, despite path.resolve canceling redirect/..
        assert.equal(path.resolve(path.dirname(c.shim), target), c.entry);
        assert.equal(await fs.realpath(c.shim), foreignEntry);
        assert.notEqual(await fs.realpath(c.shim), c.entry);
      }
      if (kind === 'deleted-entry') await assert.rejects(ownCommandLink(c.shim, c.packageRoot, platform), { code: 'ENOENT' });
      else assert.equal(await ownCommandLink(c.shim, c.packageRoot, platform), false);
      await assert.rejects(main(['setup'], c.options), /kind=symlink|ENOENT/);
      assert.deepEqual(c.counts(), [0, 0]);
      assert.equal(await fs.readlink(c.shim), target);
      assert.equal(await fs.readFile(foreignEntry, 'utf8'), '// foreign command');
      if (kind === 'deleted-entry') await assert.rejects(fs.lstat(c.entry), { code: 'ENOENT' });
      else assert.equal(await fs.readFile(c.entry, 'utf8'), '// inert npm entry');
      await assert.rejects(fs.stat(path.join(c.root, 'default-install.json')), { code: 'ENOENT' });
    });
  }
}
test('foreign symlink fails before download with safe path and observed kind', async t => {
  const c = await fresh(t); if (!await symlink(t, c.entry + '.foreign', c.shim)) return;
  await assert.rejects(main(['setup'], c.options), error => {
    assert.match(error.message, /Invalid installation baseline file/);
    assert.ok(error.message.includes(JSON.stringify(c.shim)));
    assert.match(error.message, /kind=symlink/); return true;
  });
  assert.deepEqual(c.counts(), [0, 0]);
});
test('regular legacy launcher is pinned and a download-time swap is rejected', async t => {
  const c = await fresh(t); await fs.writeFile(c.shim, 'legacy native launcher');
  const download = c.options.downloadImpl;
  c.options.downloadImpl = async (...args) => {
    await download(...args); await fs.rename(c.shim, c.shim + '.old');
    await fs.writeFile(c.shim, 'replacement');
  };
  await assert.rejects(main(['setup'], c.options), /Installation changed while staging/);
  assert.deepEqual(c.counts(), [1, 0]);
  assert.equal(await fs.readFile(c.shim, 'utf8'), 'replacement');
});
test('single-link regular legacy launcher continues through setup', async t => {
  const c = await fresh(t); await fs.writeFile(c.shim, 'legacy native launcher');
  await main(['setup'], c.options); assert.deepEqual(c.counts(), [1, 1]);
});
test('own npm link does not hide a legacy locator or its staging-time replacement', async t => {
  const c = await fresh(t); if (!await npmLink(t, c)) return;
  await fs.mkdir(c.root, { recursive: true });
  const locator = path.join(c.root, 'default-install.json'); await fs.writeFile(locator, '{}');
  const download = c.options.downloadImpl;
  c.options.downloadImpl = async (...args) => {
    await download(...args); await fs.rename(locator, locator + '.old'); await fs.writeFile(locator, '{}');
  };
  await assert.rejects(main(['setup'], c.options), /Installation changed while staging/);
  assert.deepEqual(c.counts(), [1, 0]);
  assert.ok((await fs.lstat(c.shim)).isSymbolicLink());
});
test('environment registration input cannot impersonate the executing package', async t => {
  const c = await fresh(t); if (!await npmLink(t, c)) return;
  c.options.environment.STACKBITE_NPM_REGISTRATION = JSON.stringify({ root: c.packageRoot });
  c.options.packageRoot = path.join(c.area, 'source');
  await assert.rejects(main(['setup'], c.options), /kind=symlink/);
  assert.deepEqual(c.counts(), [0, 0]);
});
test('hard-linked legacy launcher remains invalid before download', async t => {
  const c = await fresh(t); await fs.writeFile(c.shim, 'legacy'); await fs.link(c.shim, c.shim + '.alias');
  await assert.rejects(main(['setup'], c.options), /kind=regular, nlink=2/);
  assert.deepEqual(c.counts(), [0, 0]);
});
test('existing incarnation retains its early return even with a foreign command link', async t => {
  const c = await fresh(t); if (!await symlink(t, c.entry + '.foreign', c.shim)) return;
  await fs.mkdir(c.root, { recursive: true });
  await fs.writeFile(path.join(c.root, 'default-install.json'), JSON.stringify({ installation_id: 'a'.repeat(32) }));
  await main(['setup'], c.options); assert.deepEqual(c.counts(), [1, 1]);
});
for (const kind of ['source', 'npx', 'entry-link', 'wrong-bin']) {
  test(`own-command proof excludes ${kind} provenance`, async t => {
    const c = await fresh(t); if (!await npmLink(t, c)) return;
    if (kind === 'source') await fs.mkdir(path.join(c.packageRoot, '.git'));
    if (kind === 'entry-link') {
      await fs.rename(c.entry, c.entry + '.real'); await fs.symlink(c.entry + '.real', c.entry, 'file');
    }
    if (kind === 'wrong-bin') await fs.writeFile(path.join(c.packageRoot, 'package.json'), JSON.stringify({ name: 'stackbite', bin: { stackbite: 'foreign.js' } }));
    if (kind === 'npx') {
      const root = path.join(c.area, '_npx/cache/lib/node_modules/stackbite');
      await fs.mkdir(root, { recursive: true }); await fs.copyFile(path.join(c.packageRoot, 'package.json'), path.join(root, 'package.json'));
      assert.equal(await ownCommandLink(c.shim, root, 'linux'), false); return;
    }
    if (kind === 'source') await assert.rejects(ownCommandLink(c.shim, c.packageRoot, 'linux'), /Source npm package/);
    else assert.equal(await ownCommandLink(c.shim, c.packageRoot, 'linux'), false);
  });
}
