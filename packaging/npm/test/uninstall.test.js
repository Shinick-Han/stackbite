'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../lib/bootstrap');
const { fixture } = require('./fixtures');
const { registration, removeRegistration } = require('../lib/uninstall-registration');
const { explicitApply, descriptor, resumeWithoutRuntime } = require('../lib/uninstall-registration');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');

test('uninstall and delete never download a missing runtime', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-uninstall-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'missing');
  const sample = fixture();
  for (const command of ['uninstall', 'delete']) {
    await assert.rejects(main([command, '--all', '--apply'], { manifest: sample.manifest,
      platform: 'linux', arch: 'x64', glibcVersionRuntime: '2.28', cache, runtime: path.join(root, 'missing-runtime'),
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
  const launch = async (...args) => { calls.push(args); await fs.rm(packageRoot, { recursive: true }); return { code: 0, signal: null }; };
  const accepted = { code: 2, signal: null };
  assert.deepEqual(await removeRegistration(['uninstall', '--all', '--apply'], accepted, {}, launch,
    { packageRoot, platform: 'win32', npmCli: 'inert-npm-cli.js', nodeExecutable: 'inert-node' }), accepted);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'inert-node');
  assert.deepEqual(calls[0][1], ['inert-npm-cli.js', 'uninstall', '--global', '--prefix', prefix,
    'stackbite', '--ignore-scripts', '--offline', '--no-audit', '--no-fund']);
  assert.equal(calls[0][2].npm_config_update_notifier, 'false');
  await assert.rejects(fs.stat(packageRoot), { code: 'ENOENT' });
});

test('preview and native refusal never invoke npm; source and npx registrations remain', async t => {
  const { packageRoot, prefix } = await registered(t);
  const launch = async () => assert.fail('npm must not run');
  const ok = { code: 0, signal: null };
  await removeRegistration(['delete', '--preview'], ok, {}, launch, { packageRoot });
  await removeRegistration(['uninstall', '--preview'], { code: 2 }, {}, launch, { packageRoot });
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

test('default uninstall aliases and compatible flags express intent; previews never do', () => {
  for (const args of [['uninstall'], ['delete'], ['uninstall', '--yes'], ['delete', '--resume', '--apply'],
    ['uninstall', '--keep-data'], ['uninstall', '--all', '--apply']]) assert.equal(explicitApply(args), true);
  for (const args of [['delete', '--preview'], ['uninstall', '--help'], ['uninstall', '--bogus'],
    ['uninstall', '--all', '--keep-data'], ['uninstall', '--resume', '--all']]) assert.equal(explicitApply(args), false);
});

test('npm descriptor is exact, resolves executable paths and never claims a source registration', async t => {
  const { prefix, packageRoot } = await registered(t);
  const node = path.join(prefix, 'inert-node'), cli = path.join(prefix, 'inert-npm-cli.js');
  await fs.writeFile(node, 'inert'); await fs.writeFile(cli, 'inert');
  assert.deepEqual(await descriptor({ packageRoot, platform: 'win32', nodeExecutable: node, npmCli: cli }),
    { root: packageRoot, prefix, node: await fs.realpath(node), cli: await fs.realpath(cli) });
  assert.equal(await descriptor({ packageRoot: path.join(prefix, 'source'), platform: 'win32' }), null);
  await fs.mkdir(path.join(packageRoot,'.git'));
  await assert.rejects(descriptor({ packageRoot, platform:'win32',nodeExecutable:node,npmCli:cli }), /Source npm package preserved/);
});

test('missing runtime resumes only the exact pinned accepted journal capsule without rewriting it', async t => {
  const { prefix } = await registered(t);
  const root = path.join(prefix, 'Stackbite');
  await fs.mkdir(root);
  const journal = path.join(root, '.stackbite-uninstall.json'), helper = journal.replace(/\.json$/, '.sh');
  const bytes = Buffer.from('#!/bin/sh\n# inert test capsule\n');
  await fs.writeFile(helper, bytes);
  const capsule = journal.replace(/\.json$/, '.cleanup'), nativeBytes = Buffer.from('inert current native capsule');
  await fs.writeFile(capsule, nativeBytes);
  const record = { schema: 'stackbite.uninstall.v1', accepted: true, processes_settled: true,
    request_id: 'same-removal', install_identity: { root, incarnation: 'a'.repeat(32) },
    recovery_command: ['sh', helper], helper_files: [
      { path: helper, sha256: createHash('sha256').update(bytes).digest('hex') },
      { path: capsule, sha256: createHash('sha256').update(nativeBytes).digest('hex') }] };
  await fs.writeFile(journal, JSON.stringify(record));
  const before = await fs.readFile(journal);
  const calls = [], launch = async (...args) => { calls.push(args); return { code: 2, signal: null }; };
  assert.deepEqual(await resumeWithoutRuntime(['uninstall'], {}, launch, { installRoot: root, platform: 'linux' }), { code: 2, signal: null });
  assert.deepEqual(calls[0].slice(0, 2), ['sh', [helper]]);
  assert.deepEqual(await fs.readFile(journal), before);
  await fs.writeFile(capsule, 'changed capsule bytes, same file identity');
  await assert.rejects(resumeWithoutRuntime(['uninstall'], {}, launch, { installRoot: root, platform: 'linux' }), /capsule changed/);
  assert.equal(calls.length, 1);
  await fs.writeFile(capsule, nativeBytes);
  await fs.writeFile(helper, 'replaced script');
  await assert.rejects(resumeWithoutRuntime(['uninstall'], {}, launch, { installRoot: root, platform: 'linux' }), /capsule changed/);
  assert.equal(calls.length, 1);
  assert.equal(await resumeWithoutRuntime(['uninstall', '--preview'], {}, launch, { installRoot: root, platform: 'linux' }), null);
  record.processes_settled = false;
  await fs.writeFile(journal, JSON.stringify(record));
  assert.equal(await resumeWithoutRuntime(['delete'], {}, launch, { installRoot: root, platform: 'linux' }), null);
});


async function freshRegistration(t, platform = process.platform) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stackbite-registration-only-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, '.nvm', 'versions', 'node', 'v22.23.2'), home = path.join(root, 'home');
  const packageRoot = path.join(prefix, platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'stackbite');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.mkdir(path.join(root, '.nvm', '.git'));
  await fs.writeFile(path.join(root, '.nvm', 'foreign-source'), 'nvm source');
  await fs.mkdir(path.join(path.dirname(packageRoot), 'unrelated'));
  await fs.writeFile(path.join(path.dirname(packageRoot), 'unrelated', 'package.json'), '{"name":"unrelated"}');
  await fs.writeFile(path.join(packageRoot, 'package.json'), '{"name":"stackbite"}');
  const environment = { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(root, 'local'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'), STACKBITE_STATE_DIR: path.join(root, 'custom'),
    PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ''),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  return { root, prefix, packageRoot, environment };
}

function installRoot(environment, platform = process.platform) {
  const home = environment.USERPROFILE || environment.HOME;
  return path.join(platform === 'win32' ? environment.LOCALAPPDATA || home
    : environment.XDG_DATA_HOME || path.join(environment.HOME || home, '.local', 'share'),
    platform === 'win32' ? 'Stackbite' : 'stackbite');
}

for (const mode of ['same-home', 'distinct-home', 'localappdata', 'home-only']) {
  test(`ordinary Windows uninstall resumes the canonical accepted capsule (${mode})`, async t => {
    const { root: area, packageRoot, environment } = await freshRegistration(t, 'win32');
    if (mode !== 'localappdata') delete environment.LOCALAPPDATA;
    if (mode === 'distinct-home' || mode === 'localappdata') environment.HOME = path.join(area, 'other-home');
    if (mode === 'home-only') delete environment.USERPROFILE;
    const root = installRoot(environment, 'win32');
    await fs.mkdir(root, { recursive: true });
    const journal = path.join(root, '.stackbite-uninstall.json');
    const helper = journal.replace(/\.json$/, '.ps1'), bytes = Buffer.from('# inert pinned capsule\n');
    await fs.writeFile(helper, bytes);
    const record = { schema: 'stackbite.uninstall.v1', accepted: true, processes_settled: true,
      request_id: 'same-removal', install_identity: { root, incarnation: 'a'.repeat(32) },
      recovery_command: ['powershell.exe', '-NoProfile', '-File', helper],
      helper_files: [{ path: helper, sha256: createHash('sha256').update(bytes).digest('hex') }] };
    await fs.writeFile(journal, JSON.stringify(record));
    const before = await fs.readFile(journal);
    const unknown = path.join(root, 'unknown-file');
    await fs.writeFile(unknown, 'preserve unknown');
    const calls = [], options = { manifest: fixture('win32').manifest, platform: 'win32', arch: 'x64',
      packageRoot, environment, progress: () => {},
      downloadImpl: () => assert.fail('removal downloaded a runtime'),
      spawnImpl(executable, args, spawnOptions) {
        calls.push({ executable, args, environment: spawnOptions.env });
        const child = new EventEmitter();
        process.nextTick(() => child.emit('exit', 2, null));
        return child;
      } };
    // A partial result is retried by the same ordinary command, without an override.
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await main(['uninstall'], options), { code: 2, signal: null });
      assert.deepEqual(await fs.readFile(journal), before);
    }
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.executable, 'powershell.exe');
      assert.deepEqual(call.args, ['-NoProfile', '-File', helper]);
      assert.deepEqual(call.environment, environment);
    }
    // Partial npm removal can leave this module alone, without bootstrap/cache siblings.
    const standalone = path.join(area, 'standalone', 'uninstall-registration.js');
    await fs.mkdir(path.dirname(standalone));
    await fs.copyFile(path.join(__dirname, '../lib/uninstall-registration.js'), standalone);
    const recovered = require(standalone).resumeWithoutRuntime;
    let standaloneCalls = 0;
    assert.deepEqual(await recovered(['uninstall'], environment, async (exe, args) => {
      standaloneCalls++;
      assert.equal(exe, 'powershell.exe');
      assert.deepEqual(args, ['-NoProfile', '-File', helper]);
      return { code: 2, signal: null };
    }, { platform: 'win32' }), { code: 2, signal: null });
    assert.equal(standaloneCalls, 1);
    assert.deepEqual(await fs.readFile(journal), before);
    await fs.writeFile(helper, 'replacement capsule');
    await assert.rejects(main(['uninstall'], options), /capsule changed/);
    assert.equal(calls.length, 2);
    assert.equal(await fs.readFile(helper, 'utf8'), 'replacement capsule');
    assert.deepEqual(await fs.readFile(journal), before);
    assert.equal(await fs.readFile(unknown, 'utf8'), 'preserve unknown');
    assert.equal(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'), '{"name":"stackbite"}');
  });
}

async function prepare(environment, bytes = '', platform = process.platform) {
  const root = installRoot(environment, platform), file = path.join(root, '.stackbite-update', 'update.lock');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return { root, file };
}

for (const bytes of ['', '0']) test(`ordinary npm uninstall cancels actual firstever download with held preparation (${JSON.stringify(bytes)})`, async t => {
  const { root, packageRoot, environment } = await freshRegistration(t);
  const sample = fixture(process.platform), stages = [];
  const cli = path.join(root, 'inert-npm.js');
  await fs.writeFile(cli, `require('node:fs').rmSync(${JSON.stringify(packageRoot)}, {recursive:true});process.exitCode=4;`);
  const options = { manifest: sample.manifest, platform: process.platform, arch: process.platform === 'darwin' ? 'arm64' : 'x64',
    glibcVersionRuntime: '2.28', packageRoot, environment, nodeExecutable: process.execPath, npmCli: cli, progress: () => {} };
  await assert.rejects(main(['setup'], { ...options, async downloadImpl(spec, archive) {
    stages.push(path.dirname(archive));
    const file = path.join(installRoot(environment), '.stackbite-update', 'update.lock');
    assert.equal(await fs.readFile(file, 'utf8'), '');
    if (bytes) await fs.writeFile(file, bytes);
    assert.deepEqual(await main(['uninstall'], { ...options,
      downloadImpl: () => assert.fail('uninstall downloaded a runtime') }), { code: 0, signal: null });
    await assert.rejects(fs.lstat(installRoot(environment)), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(packageRoot), { code: 'ENOENT' });
    await fs.writeFile(archive, sample.bytes);
  }, spawnImpl: () => assert.fail('old publisher executed after ordinary uninstall') }), /Installation changed while staging/);
  for (const stage of stages) await assert.rejects(fs.lstat(stage), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(installRoot(environment)), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(environment.XDG_CACHE_HOME, 'stackbite')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, '.nvm/foreign-source'), 'utf8'), 'nvm source');
  assert.equal(await fs.readFile(path.join(path.dirname(packageRoot), 'unrelated/package.json'), 'utf8'), '{"name":"unrelated"}');
});

test('cancelled download leaves only preparation removable by ordinary npm uninstall', async t => {
  const { root, packageRoot, environment } = await freshRegistration(t);
  const sample = fixture(process.platform), cli = path.join(root, 'inert-npm.js');
  await fs.writeFile(cli, `require('node:fs').rmSync(${JSON.stringify(packageRoot)}, {recursive:true});`);
  const options = { manifest: sample.manifest, platform: process.platform, arch: process.platform === 'darwin' ? 'arm64' : 'x64',
    glibcVersionRuntime: '2.28', packageRoot, environment, nodeExecutable: process.execPath, npmCli: cli, progress: () => {} };
  await assert.rejects(main(['setup'], { ...options, downloadImpl: () => { throw Error('cancelled download'); } }), /cancelled download/);
  assert.deepEqual(await fs.readdir(installRoot(environment)), ['.stackbite-update']);
  assert.deepEqual(await main(['uninstall'], options), { code: 0, signal: null });
  await assert.rejects(fs.lstat(installRoot(environment)), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(packageRoot), { code: 'ENOENT' });
});

test('Windows preparation fallback uses the publisher USERPROFILE when HOME differs', async t => {
  const { root: area, packageRoot, environment } = await freshRegistration(t, 'win32');
  delete environment.LOCALAPPDATA;
  environment.HOME = path.join(area, 'different-home');
  await fs.mkdir(environment.HOME);
  await fs.writeFile(path.join(environment.HOME, 'sentinel'), 'foreign home');
  const { root } = await prepare(environment, '', 'win32');
  assert.deepEqual(await require('../lib/uninstall-registration').registrationOnly(['uninstall'], environment,
    async () => { await fs.rm(packageRoot, { recursive: true }); return { code: 0, signal: null }; },
    { packageRoot, platform: 'win32', nodeExecutable: process.execPath, npmCli: path.join(area, 'inert-npm.js') }), { code: 0, signal: null });
  await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(environment.HOME, 'sentinel'), 'utf8'), 'foreign home');
});

for (const kind of ['npm-cache', 'locator-cache', 'legacy-locator-cache', 'legacy-npm-cache']) {
  test(`Windows fallback no-runtime proof preserves existing payload (${kind})`, async t => {
    const { root: area, packageRoot, environment } = await freshRegistration(t, 'win32');
    delete environment.LOCALAPPDATA;
    const { file } = await prepare(environment, '', 'win32');
    const profile = environment.USERPROFILE;
    const locations = {
      'npm-cache': path.join(profile, 'AppData/Local/Stackbite/cache'),
      'locator-cache': path.join(profile, 'Stackbite/cache'),
      'legacy-locator-cache': path.join(profile, 'Helm/cache'),
      'legacy-npm-cache': path.join(profile, 'AppData/Local/Helm/cache')
    };
    const payload = path.join(locations[kind], 'retained-runtime');
    await fs.mkdir(path.dirname(payload), { recursive: true });
    await fs.writeFile(payload, 'owned or unknown payload remains');
    assert.equal(await require('../lib/uninstall-registration').registrationOnly(['uninstall'], environment,
      () => assert.fail('existing payload authorized npm-only removal'),
      { packageRoot, platform: 'win32', nodeExecutable: process.execPath, npmCli: path.join(area, 'inert-npm.js') }), null);
    assert.equal(await fs.readFile(payload, 'utf8'), 'owned or unknown payload remains');
    assert.equal(await fs.readFile(file, 'utf8'), '');
    assert.equal(JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')).name, 'stackbite');
  });
}

for (const kind of ['bytes', 'oversized', 'hardlink', 'file-redirect', 'root-redirect', 'control-redirect', 'source',
  'unknown-directory', 'unknown-control', 'locator', 'journal', 'native-claim', 'manifest', 'runtime', 'custom-state', 'foreign-root', 'replaced-file', 'late-replaced-file']) {
  test(`preparation-only removal preserves unsafe or nonempty installation (${kind})`, async t => {
    const { root: area, packageRoot, environment } = await freshRegistration(t);
    const { root, file } = await prepare(environment);
    const options = { packageRoot, platform: process.platform, nodeExecutable: process.execPath, npmCli: path.join(area, 'inert-npm.js') };
    const foreign = path.join(area, 'foreign');
    await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, 'sentinel'), 'foreign project');
    if (kind === 'bytes') await fs.writeFile(file, 'x');
    else if (kind === 'oversized') await fs.writeFile(file, 'unknown');
    else if (kind === 'hardlink') await fs.link(file, path.join(foreign, 'linked-lock'));
    else if (kind === 'file-redirect') {
      await fs.unlink(file);
      // A junction is a real Windows redirect and needs no symlink privilege.
      await fs.symlink(foreign, file, process.platform === 'win32' ? 'junction' : 'file');
    } else if (['root-redirect', 'control-redirect'].includes(kind)) {
      const location = kind === 'root-redirect' ? root : path.dirname(file);
      await fs.rename(location, path.join(foreign, 'original'));
      await fs.symlink(path.join(foreign, 'original'), location, process.platform === 'win32' ? 'junction' : 'dir');
    } else if (kind === 'source') await fs.mkdir(path.join(area, '.git'));
    else if (kind === 'unknown-directory') await fs.mkdir(path.join(root, 'unknown'));
    else if (kind === 'unknown-control') await fs.writeFile(path.join(path.dirname(file), 'foreign'), 'unknown');
    else if (kind === 'custom-state') { await fs.mkdir(environment.STACKBITE_STATE_DIR); await fs.writeFile(path.join(environment.STACKBITE_STATE_DIR, 'owned'), 'state'); }
    else if (kind === 'foreign-root') options.installRoot = (await prepare({ ...environment,
      LOCALAPPDATA: foreign, XDG_DATA_HOME: foreign })).root;
    else if (kind === 'replaced-file') {
      const open = fs.open;
      t.mock.method(fs, 'open', async (...args) => {
        const handle = await open(...args);
        if (args[0] === file) { await fs.unlink(file); await fs.writeFile(file, '0'); }
        return handle;
      });
    } else if (kind === 'late-replaced-file') {
      const readdir = fs.readdir;
      let inspections = 0;
      t.mock.method(fs, 'readdir', async (...args) => {
        const names = await readdir(...args);
        if (args[0] === root && ++inspections === 3) { await fs.unlink(file); await fs.writeFile(file, '0'); }
        return names;
      });
    } else {
      const names = { locator: 'default-install.json', journal: '.stackbite-uninstall.json',
        'native-claim': '.stackbite-native-claim.json', manifest: 'native-executable-assets.json', runtime: 'stackbite' };
      await fs.writeFile(path.join(root, names[kind]), 'existing artifact');
    }
    const result = await require('../lib/uninstall-registration').registrationOnly(['uninstall'], environment,
      () => assert.fail('unsafe preparation invoked npm'), options);
    assert.equal(result, null);
    assert.ok(await fs.lstat(file));
    assert.ok(await fs.lstat(packageRoot));
    assert.equal(await fs.readFile(path.join(foreign, 'sentinel'), 'utf8'), 'foreign project');
    if (kind.includes('replaced-file')) assert.equal(await fs.readFile(file, 'utf8'), '0');
  });
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`fresh ${platform} npm-only uninstall removes exact registration without runtime, journal or download`, async t => {
    const { root, prefix, packageRoot, environment } = await freshRegistration(t, platform);
    const { EventEmitter } = require('node:events');
    const calls = [];
    const result = await main(['uninstall'], { manifest: fixture(platform).manifest, platform, arch: platform === 'darwin' ? 'arm64' : 'x64',
      glibcVersionRuntime: '2.28', packageRoot, environment, cache: path.join(root, 'missing-cache'),
      nodeExecutable: process.execPath, npmCli: path.join(root, 'inert-npm-cli.js'),
      downloadImpl: async () => assert.fail('npm-only uninstall downloaded a runtime'),
      spawnImpl: (exe, args) => { calls.push([exe,args]); const child = new EventEmitter();
        queueMicrotask(async () => { await fs.rm(packageRoot,{ recursive:true }); child.emit('exit',4,null); }); return child; } });
    assert.deepEqual(result,{ code:0,signal:null });
    assert.equal(calls.length,1); assert.equal(calls[0][1][4],prefix);
    await assert.rejects(fs.stat(packageRoot),{code:'ENOENT'});
    await assert.rejects(fs.stat(path.join(root,'missing-cache')),{code:'ENOENT'});
  });
}

test('registration-only proof refuses existing canonical, legacy, custom state and preview', async t => {
  const { registrationOnly } = require('../lib/uninstall-registration');
  const { root,packageRoot,environment } = await freshRegistration(t,'linux');
  const options={packageRoot,platform:'linux',nodeExecutable:process.execPath,npmCli:path.join(root,'inert-npm.js')};
  const launch=async()=>assert.fail('existing data must retain the ordinary npm command');
  const cases=[path.join(environment.XDG_DATA_HOME,'stackbite','default-install.json'),
    path.join(environment.XDG_DATA_HOME,'helm','state','owned'),path.join(environment.STACKBITE_STATE_DIR,'custom-owned'),
    path.join(environment.XDG_STATE_HOME,'stackbite','foreign-unknown')];
  for(const file of cases){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'retained');
    assert.equal(await registrationOnly(['uninstall'],environment,launch,options),null);await fs.unlink(file);}
  assert.equal(await registrationOnly(['uninstall','--preview'],environment,launch,options),null);
  assert.equal((await fs.stat(packageRoot)).isDirectory(),true);
});

for (const keepEntry of [false, true]) test(`npm-only partial shim/lib removal restores the actual ordinary command (retained bin: ${keepEntry})`, async t => {
  const { registrationOnly } = require('../lib/uninstall-registration');
  const { root,prefix,packageRoot,environment } = await freshRegistration(t);
  const entry=path.join(packageRoot,'packaging/npm/bin/stackbite.js');
  await fs.mkdir(path.dirname(entry),{recursive:true});await fs.copyFile(path.join(__dirname,'../bin/stackbite.js'),entry);
  const lib=path.join(packageRoot,'packaging/npm/lib');await fs.mkdir(lib);
  await fs.writeFile(path.join(lib,'bootstrap.js'),'module.exports.main=async()=>({code:0,signal:null})');
  await fs.writeFile(path.join(packageRoot,'package.json'),JSON.stringify({name:'stackbite',bin:{stackbite:'packaging/npm/bin/stackbite.js'}}));
  const shim=process.platform==='win32'?path.join(prefix,'stackbite.cmd'):path.join(prefix,'bin/stackbite');
  await fs.mkdir(path.dirname(shim),{recursive:true});
  if(process.platform==='win32')await fs.writeFile(shim,`@ECHO off\nSETLOCAL\nSET "_prog=${process.execPath}"\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%~dp0node_modules\\stackbite\\packaging\\npm\\bin\\stackbite.js" %*\n`);
  else await fs.symlink('../lib/node_modules/stackbite/packaging/npm/bin/stackbite.js',shim);
  const cli=path.join(root,'fake-npm.js');
  await fs.writeFile(cli,`const fs=require('node:fs');fs.rmSync(${JSON.stringify(packageRoot)},{recursive:true});fs.unlinkSync(${JSON.stringify(shim)});process.exitCode=4;`);
  const options={packageRoot,nodeExecutable:process.execPath,npmCli:cli};
  const preparation = await prepare(environment);
  const held = await fs.open(preparation.file, 'r');
  t.after(() => held.close());
  await assert.rejects(registrationOnly(['uninstall'],environment,async()=>{await fs.unlink(shim);await fs.rm(lib,{recursive:true});if(!keepEntry)await fs.unlink(entry);return {code:4,signal:null};},options),/registration removal failed/);
  await assert.rejects(fs.lstat(preparation.root), {code:'ENOENT'});
  assert.equal((await fs.stat(entry)).isFile(),true);assert.equal((await fs.lstat(shim)).isSymbolicLink(),process.platform!=='win32');
  const command=process.platform==='win32'?'cmd.exe':shim;
  const args=process.platform==='win32'?['/d','/c',shim,'uninstall']:['uninstall'];
  const child=require('node:child_process').spawnSync(command,args,{env:environment,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  await assert.rejects(fs.stat(packageRoot),{code:'ENOENT'});await assert.rejects(fs.lstat(shim),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(environment.XDG_DATA_HOME,'stackbite')),{code:'ENOENT'});
  await assert.rejects(fs.lstat(preparation.root),{code:'ENOENT'});
  assert.equal((await fs.stat(path.join(root,'.nvm/.git'))).isDirectory(),true);
  assert.equal(await fs.readFile(path.join(root,'.nvm/foreign-source'),'utf8'),'nvm source');
  assert.equal(await fs.readFile(path.join(path.dirname(packageRoot),'unrelated/package.json'),'utf8'),'{"name":"unrelated"}');
});
