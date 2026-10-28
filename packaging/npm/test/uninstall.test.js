'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../lib/bootstrap');
const { fixture } = require('./fixtures');
const { registration, removeRegistration } = require('../lib/uninstall-registration');

test('uninstall and delete never download a missing runtime', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-uninstall-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'missing');
  const sample = fixture();
  for (const command of ['uninstall', 'delete']) {
    await assert.rejects(main([command, '--all', '--apply'], { manifest: sample.manifest,
      platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.28', cache,
      downloadImpl: async () => { assert.fail('removal downloaded a runtime'); } }), /not cached/);
  }
  await assert.rejects(fs.stat(cache), { code: 'ENOENT' });
});

async function registered(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-registration-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'literal prefix & spaces');
  const packageRoot = path.join(prefix, 'node_modules', 'stackbite');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'stackbite' }));
  return { prefix, packageRoot };
}

test('explicit accepted removal uses npm for this exact global registration without scripts or network', async t => {
  const { prefix, packageRoot } = await registered(t);
  const calls = [];
  const launch = async (...args) => { calls.push(args); return { code: 0, signal: null }; };
  const accepted = { code: 2, signal: null };
  assert.deepEqual(await removeRegistration(['uninstall', '--all', '--apply'], accepted, {}, launch,
    { packageRoot, platform: 'win32', npmCli: 'inert-npm-cli.js', nodeExecutable: 'inert-node' }), accepted);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'inert-node');
  assert.deepEqual(calls[0][1], ['inert-npm-cli.js', 'uninstall', '--global', '--prefix', prefix,
    'stackbite', '--ignore-scripts', '--offline', '--no-audit', '--no-fund']);
  assert.equal(calls[0][2].npm_config_update_notifier, 'false');
  assert.equal((await fs.stat(packageRoot)).isDirectory(), true); // Recording stub removed nothing.
});

test('preview and native refusal never invoke npm; source and npx registrations remain', async t => {
  const { packageRoot, prefix } = await registered(t);
  const launch = async () => assert.fail('npm must not run');
  const ok = { code: 0, signal: null };
  await removeRegistration(['delete'], ok, {}, launch, { packageRoot });
  await removeRegistration(['uninstall', '--apply'], { code: 2 }, {}, launch, { packageRoot });
  await removeRegistration(['uninstall', '--all', '--apply', '--help'], ok, {}, launch, { packageRoot });
  await removeRegistration(['delete', '--apply'], { code: 1 }, {}, launch, { packageRoot });
  assert.equal(await registration(path.join(prefix, 'source')), null);
  const npx = path.join(prefix, '_npx', 'hash', 'node_modules', 'stackbite');
  await fs.mkdir(npx, { recursive: true });
  await fs.writeFile(path.join(npx, 'package.json'), '{"name":"stackbite"}');
  assert.equal(await registration(npx), null);
  await fs.writeFile(path.join(packageRoot, 'package.json'), '{"name":"unrelated"}');
  await assert.rejects(registration(packageRoot, 'win32'), /Foreign npm/);
});

test('Linux global lib prefix is exact and project-local registration is retained', async t => {
  const { prefix, packageRoot } = await registered(t);
  const linux = path.join(prefix, 'lib', 'node_modules', 'stackbite');
  await fs.mkdir(linux, { recursive: true });
  await fs.writeFile(path.join(linux, 'package.json'), '{"name":"stackbite"}');
  assert.equal(await registration(linux, 'linux'), prefix);
  assert.equal(await registration(packageRoot, 'linux'), null);
  await fs.writeFile(path.join(prefix, 'package.json'), '{"name":"user-project"}');
  assert.equal(await registration(packageRoot, 'win32'), null);
});
